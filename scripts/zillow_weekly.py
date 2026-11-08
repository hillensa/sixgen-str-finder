# -*- coding: utf-8 -*-
"""
Weekly Zillow pull for Lexington, KY, using the saved search (default 4+ beds, 3+ baths, HOA <= $0).

The browser half lives in scripts/zillow_extract.js; this is the local half.

    python scripts/zillow_weekly.py url
        Print the Zillow search URL the weekly run uses (from the saved search).

    python scripts/zillow_weekly.py criteria
        Print the saved search as beds>=N|baths>=N|hoa<=N — the same form the
        extractor reports, so the two can be compared.

    python scripts/zillow_weekly.py verify <page.psv> <sha256>
        Check a page file against the checksum the browser computed. Writes a
        <page.psv>.ok marker on success. A page without one is never imported.

    python scripts/zillow_weekly.py import <run_dir> --expected-total N [--dry-run]
        Combine the verified pages, enforce the criteria, import through the
        app's own refresh endpoint, then re-forecast and re-rank.

Invariants this script exists to protect:
  * A partial pull never runs a full sync. Full sync retires every Zillow
    listing missing from the set, so a pull cut short by a challenge page would
    mark every home on the missed pages as removed. Partial pulls add and update
    only, and say so.
  * Rows are checked against the criteria here too, so a search URL that drifts
    cannot quietly widen what lands in the database.
  * It talks to a dev server it verifies is THIS app (via /api/health), on a
    port of its own, and stops the server afterwards if it started it.
"""
import csv, datetime, hashlib, io, json, os, subprocess, sys, time, urllib.error, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(os.environ.get("ZILLOW_PULL_PORT", "3017"))
BASE = "http://localhost:%d" % PORT
MIN_BEDS, MIN_BATHS = 4, 3     # defaults only; the saved search in app_settings wins
COMPLETE_RATIO = 0.95          # pulled / Zillow's own total needed to full-sync
SETTINGS_KEY = "zillow_search"  # edited on the app's Zillow Pull page

SEARCH_STATE = {
    "pagination": {},
    "isMapVisible": True,
    "mapBounds": {"west": -84.6964414038086, "east": -84.32496618408204,
                  "south": 37.916986811795695, "north": 38.156566399445715},
    "regionSelection": [{"regionId": 25574, "regionType": 6}],     # Lexington, KY
    "filterState": {
        "sort": {"value": "globalrelevanceex"},
        "beds": {"min": MIN_BEDS},
        "baths": {"min": MIN_BATHS},
        "hoa": {"max": 0},
    },
    "isListVisible": True,
    "mapZoom": 12,
    "usersSearchTerm": "Lexington KY",
}

TYPE = {"SINGLE_FAMILY": "SF", "CONDO": "Condo", "TOWNHOUSE": "Townhouse",
        "MULTI_FAMILY": "Multi-family", "MANUFACTURED": "Manufactured", "LOT": "Lot"}
FIELDS = ["zpid", "address", "zip", "lat", "lng", "price", "beds", "baths",
          "sqft", "lot_sqft", "home_type", "dom", "photo_hash"]


def criteria():
    """The saved search from app_settings, so this pull and the app's Zillow Pull
    page always use the same numbers. Falls back to 4 bd / 3 ba / $0 HOA."""
    out = {"bedsMin": MIN_BEDS, "bathsMin": MIN_BATHS, "hoaMax": 0}
    try:
        env = env_local()
        base = env["NEXT_PUBLIC_SUPABASE_URL"].rstrip("/") + "/rest/v1/"
        key = env["SUPABASE_SERVICE_ROLE_KEY"]
        req = urllib.request.Request(base + "app_settings?select=value&key=eq." + SETTINGS_KEY,
                                     headers={"apikey": key, "Authorization": "Bearer " + key})
        with urllib.request.urlopen(req, timeout=30) as r:
            rows = json.loads(r.read().decode("utf-8"))
        if rows:
            v = rows[0]["value"]
            for k in out:
                if isinstance(v.get(k), int):
                    out[k] = v[k]
    except Exception as e:  # never block a pull on the settings read; say so
        print("note: could not read saved search (%s); using defaults" % e, file=sys.stderr)
    return out


def search_url():
    c = criteria()
    SEARCH_STATE["filterState"]["beds"] = {"min": c["bedsMin"]}
    SEARCH_STATE["filterState"]["baths"] = {"min": c["bathsMin"]}
    SEARCH_STATE["filterState"]["hoa"] = {"max": c["hoaMax"]}
    q = json.dumps(SEARCH_STATE, separators=(",", ":"))
    return "https://www.zillow.com/lexington-ky/?searchQueryState=" + urllib.parse.quote(q, safe="")


def read_bytes(path):
    # The browser hashed '\n'-terminated text; editors on Windows may write \r\n.
    return io.open(path, "rb").read().replace(b"\r\n", b"\n")


def verify(path, expected):
    got = hashlib.sha256(read_bytes(path)).hexdigest()
    if got != expected.strip().lower():
        print("MISMATCH %s\n  expected %s\n  got      %s" % (path, expected, got))
        print("The file does not match what the page returned. Re-extract this page; do not import it.")
        return 1
    io.open(path + ".ok", "w", encoding="utf-8").write(got + "\n")
    n = sum(1 for line in read_bytes(path).decode("utf-8").split("\n") if line.strip())
    print("OK %s  (%d homes)" % (path, n))
    return 0


def env_local():
    out = {}
    for line in io.open(os.path.join(ROOT, ".env.local"), encoding="utf-8", errors="replace"):
        t = line.strip()
        if t and not t.startswith("#") and "=" in t:
            k, v = t.split("=", 1)
            out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def health():
    try:
        with urllib.request.urlopen(BASE + "/api/health", timeout=10) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception:
        return None


def ensure_server():
    """Return a Popen we started, or None if this app was already serving."""
    h = health()
    if h:
        if h.get("service") != "sixgen-str-finder":
            raise SystemExit("Port %d is serving something else (%s). Set ZILLOW_PULL_PORT." % (PORT, h.get("service")))
        return None
    log = io.open(os.path.join(ROOT, "data", "zillow", "dev-server.log"), "w", encoding="utf-8")
    env = dict(os.environ, PORT=str(PORT))
    flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    proc = subprocess.Popen("npm run dev", cwd=ROOT, env=env, shell=True,
                            stdout=log, stderr=subprocess.STDOUT, creationflags=flags)
    for _ in range(90):
        time.sleep(2)
        h = health()
        if h and h.get("service") == "sixgen-str-finder":
            return proc
    stop_server(proc)
    raise SystemExit("The dev server did not come up on port %d; see data/zillow/dev-server.log" % PORT)


def stop_server(proc):
    if proc is None:
        return
    if os.name == "nt":
        subprocess.run("taskkill /PID %d /T /F" % proc.pid, shell=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        proc.terminate()


def post(path, body, secret):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode("utf-8"), method="POST",
                                 headers={"Content-Type": "application/json", "Authorization": "Bearer " + secret})
    try:
        with urllib.request.urlopen(req, timeout=900) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8") or "{}")


def load_run(run_dir, min_beds=MIN_BEDS, min_baths=MIN_BATHS):
    pages = sorted(f for f in os.listdir(run_dir) if f.endswith(".psv"))
    unverified = [f for f in pages if not os.path.exists(os.path.join(run_dir, f + ".ok"))]
    if unverified:
        raise SystemExit("Unverified page files: %s. Run `verify` on each first." % ", ".join(unverified))
    homes, rejected = {}, []
    for f in pages:
        for line in read_bytes(os.path.join(run_dir, f)).decode("utf-8").split("\n"):
            if not line.strip():
                continue
            row = dict(zip(FIELDS, line.split("|")))
            try:
                beds, baths = float(row["beds"] or 0), float(row["baths"] or 0)
            except ValueError:
                beds = baths = 0
            if beds < min_beds or baths < min_baths:
                rejected.append("%s (%s bd / %s ba)" % (row["address"], row["beds"], row["baths"]))
                continue
            homes[row["zpid"]] = row
    return pages, list(homes.values()), rejected


def to_csv(homes):
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=["zpid", "address", "zip", "lat", "lng", "price", "beds", "baths", "sqft",
                                        "lot_sqft", "property_type", "dom", "status", "url", "photo"])
    w.writeheader()
    for h in homes:
        w.writerow({
            "zpid": h["zpid"], "address": h["address"], "zip": h["zip"], "lat": h["lat"], "lng": h["lng"],
            "price": h["price"], "beds": h["beds"], "baths": h["baths"], "sqft": h["sqft"],
            "lot_sqft": h["lot_sqft"], "property_type": TYPE.get(h["home_type"], h["home_type"]),
            "dom": h["dom"], "status": "active",
            "url": "https://www.zillow.com/homedetails/%s_zpid/" % h["zpid"],
            "photo": ("https://photos.zillowstatic.com/fp/%s-p_e.jpg" % h["photo_hash"]) if h["photo_hash"] else "",
        })
    return buf.getvalue()


def do_import(run_dir, expected_total, dry_run):
    c = criteria()
    pages, homes, rejected = load_run(run_dir, c["bedsMin"], c["bathsMin"])
    complete = expected_total > 0 and len(homes) >= COMPLETE_RATIO * expected_total
    summary = {
        "run_dir": run_dir, "pages": len(pages), "homes": len(homes), "zillow_total": expected_total,
        "rejected_by_criteria": rejected, "complete": complete, "full_sync": complete,
    }
    print("%d verified page(s), %d homes (Zillow reported %d), %d rejected by criteria"
          % (len(pages), len(homes), expected_total, len(rejected)))
    if not homes:
        raise SystemExit("Nothing to import.")
    if not complete:
        print("PARTIAL PULL: importing without full sync, so no listing is retired this week.")
    if dry_run:
        print(json.dumps(summary, indent=1))
        return 0

    secret = env_local()["IMPORT_SECRET"]
    proc = ensure_server()
    try:
        week = datetime.date.today().isoformat()
        st, ref = post("/api/listings/refresh", {
            "market": "lexington-ky", "format": "zillow", "input": to_csv(homes),
            "fullSync": complete, "rescreen": True,
            "note": "Weekly Zillow pull %s: %d+ bd, %d+ ba, HOA <= $%d (%d of %d%s)"
                    % (week, c["bedsMin"], c["bathsMin"], c["hoaMax"], len(homes), expected_total, "" if complete else ", PARTIAL"),
        }, secret)
        summary["refresh"] = {"http": st, **{k: ref.get(k) for k in ("received", "written", "counts", "rescreened",
                                                                       "coordinates", "message", "error")}}
        if st != 200:
            raise SystemExit("Refresh failed (HTTP %s): %s" % (st, ref.get("error")))
        st, fc = post("/api/forecasts?market=lexington-ky", {}, secret)
        summary["forecasts"] = {"http": st, "message": fc.get("message"), "error": fc.get("error")}
        st, sc = post("/api/scores?market=lexington-ky", {}, secret)
        summary["scores"] = {"http": st, "message": sc.get("message"), "error": sc.get("error")}
    finally:
        stop_server(proc)

    io.open(os.path.join(run_dir, "run.json"), "w", encoding="utf-8").write(json.dumps(summary, indent=1))
    print(json.dumps(summary, indent=1))
    return 0


def main(argv):
    if len(argv) < 2:
        print(__doc__); return 2
    cmd = argv[1]
    if cmd == "url":
        print(search_url()); return 0
    if cmd == "criteria":
        c = criteria()
        print("beds>=%d|baths>=%d|hoa<=%d" % (c["bedsMin"], c["bathsMin"], c["hoaMax"])); return 0
    if cmd == "verify" and len(argv) == 4:
        return verify(argv[2], argv[3])
    if cmd == "import" and len(argv) >= 3:
        expected = 0
        if "--expected-total" in argv:
            expected = int(argv[argv.index("--expected-total") + 1])
        return do_import(argv[2], expected, "--dry-run" in argv)
    print(__doc__); return 2


if __name__ == "__main__":
    os.makedirs(os.path.join(ROOT, "data", "zillow"), exist_ok=True)
    sys.exit(main(sys.argv))
