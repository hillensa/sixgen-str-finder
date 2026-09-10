import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { limit, clientKey, ruleFor, RULES } from "../src/lib/rateLimit";
import { redact } from "../src/lib/log";

const ROOT = join(__dirname, "..");

// ── rate limiting ───────────────────────────────────────────────────────────
test("a fixed window allows up to the limit and then refuses", () => {
  const key = `t-${Math.random()}`;
  const now = 1_000_000;
  for (let i = 1; i <= 5; i++) {
    const r = limit(key, 5, 60_000, now);
    assert.equal(r.allowed, true, `request ${i} should pass`);
    assert.equal(r.remaining, 5 - i);
  }
  const blocked = limit(key, 5, 60_000, now);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
  assert.ok(blocked.retryAfter > 0, "a refusal must say when to come back");
});

test("the window reopens once it has elapsed", () => {
  const key = `t-${Math.random()}`;
  limit(key, 1, 1000, 1_000_000);
  assert.equal(limit(key, 1, 1000, 1_000_500).allowed, false, "still inside the window");
  assert.equal(limit(key, 1, 1000, 1_002_000).allowed, true, "window elapsed");
});

test("callers are limited independently", () => {
  const a = `a-${Math.random()}`, b = `b-${Math.random()}`;
  limit(a, 1, 60_000, 1_000_000);
  assert.equal(limit(a, 1, 60_000, 1_000_000).allowed, false);
  assert.equal(limit(b, 1, 60_000, 1_000_000).allowed, true, "one caller must not exhaust another's budget");
});

test("the client key prefers the proxy's forwarded address over the socket", () => {
  const req = (h: Record<string, string>) => new Request("https://x/", { headers: h });
  assert.equal(clientKey(req({ "x-nf-client-connection-ip": "1.2.3.4" })), "1.2.3.4");
  assert.equal(clientKey(req({ "x-forwarded-for": "9.9.9.9, 10.0.0.1" })), "9.9.9.9", "the client is the first entry");
  assert.equal(clientKey(req({})), "unknown");
});

test("every route reachable without a session is rate limited", () => {
  for (const p of ["/login", "/auth/callback", "/api/health", "/api/refresh", "/api/listings/refresh", "/api/scores", "/api/forecasts"]) {
    assert.ok(ruleFor(p), `${p} has no rate limit rule`);
  }
  assert.equal(ruleFor("/dashboard"), null, "session-gated pages need no limit");
  assert.ok(RULES.every((r) => r.max > 0 && r.windowMs > 0 && r.reason));
});

// ── log redaction ───────────────────────────────────────────────────────────
test("credential-shaped keys never reach a log line", () => {
  const out = redact({
    authorization: "Bearer sk-real-secret",
    cookie: "sb-access-token=abc",
    // the real risk: an env var name, which an anchored pattern would miss
    SUPABASE_SERVICE_ROLE_KEY: "super-secret",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
    IMPORT_SECRET: "hunter2",
    GUESTY_API_KEY: "g-key",
    address: "697 Cindy Blair Way",
  }) as Record<string, unknown>;
  for (const k of ["authorization", "cookie", "SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "IMPORT_SECRET", "GUESTY_API_KEY"]) {
    assert.equal(out[k], "[redacted]", `${k} leaked`);
  }
  assert.equal(out.address, "697 Cindy Blair Way", "ordinary data still logs");
});

test("redaction does not swallow the diagnostic fields that make a log useful", () => {
  const out = redact({ rule_key: "spacing_ft", factor_key: "revenue_yield", zone_code: "R-1C", external_id: "STR-1" }) as Record<string, unknown>;
  assert.equal(out.rule_key, "spacing_ft", "a bare *_key suffix is not a secret");
  assert.equal(out.factor_key, "revenue_yield");
  assert.equal(out.zone_code, "R-1C");
  assert.equal(out.external_id, "STR-1");
});

test("credential-shaped values are redacted even under an innocent key", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0";
  const out = redact({ note: `token is ${jwt}`, other: "sbp-abcdefghijklmnop" }) as Record<string, string>;
  assert.ok(!out.note.includes(jwt), "a JWT in free text must not survive");
  assert.ok(out.note.includes("[redacted]"));
  assert.ok(!out.other.includes("abcdefghijklmnop"));
});

test("redaction recurses, bounds depth, and survives odd input", () => {
  const nested = redact({ a: { b: { c: { token: "x" } } } }) as any;
  assert.equal(nested.a.b.c.token, "[redacted]");
  assert.doesNotThrow(() => redact(null));
  assert.doesNotThrow(() => redact(undefined));
  const err = redact(new Error("boom")) as any;
  assert.equal(err.message, "boom");
  const long = redact("x".repeat(5000)) as string;
  assert.ok(long.length <= 2000, "a huge string is truncated rather than flooding the log");
});

// ── error boundaries and shell ──────────────────────────────────────────────
test("every level has an error boundary, plus not-found and loading", () => {
  for (const f of ["src/app/error.tsx", "src/app/global-error.tsx", "src/app/not-found.tsx",
                   "src/app/(app)/error.tsx", "src/app/(app)/loading.tsx"]) {
    assert.ok(existsSync(join(ROOT, f)), `${f} is missing`);
  }
});

test("the error page shows the digest so a report can be matched to a log line", () => {
  const src = readFileSync(join(ROOT, "src/components/ErrorState.tsx"), "utf8");
  assert.ok(/error\.digest/.test(src));
  assert.ok(/should be relied on|not be relied/.test(src), "it must not imply the page still works");
});

test("the shell is usable on a phone", () => {
  const src = readFileSync(join(ROOT, "src/components/AppShell.tsx"), "utf8");
  assert.ok(/lg:hidden/.test(src) && /hidden .*lg:flex/.test(src), "the rail must collapse into a drawer");
  assert.ok(/aria-label="Open navigation"/.test(src));
  assert.ok(/Escape/.test(src), "the drawer must close on Escape");
});

// ── security posture ────────────────────────────────────────────────────────
test("REGRESSION: middleware lives where Next will actually load it", () => {
  // This project uses a `src` directory, and Next loads middleware only from
  // `src/middleware.ts` in that layout. A root-level middleware.ts is silently
  // ignored \u2014 which is exactly how the rate limiting and the security headers
  // came to ship dead until the Phase 7 QA pass caught it.
  assert.ok(existsSync(join(ROOT, "src", "app")), "this guard assumes the src/ layout");
  assert.ok(existsSync(join(ROOT, "src", "middleware.ts")), "middleware must be at src/middleware.ts");
  assert.ok(!existsSync(join(ROOT, "middleware.ts")),
    "a root middleware.ts alongside src/ never runs, and will mislead the next reader");
});

test("REGRESSION: an unauthenticated API call is answered, not redirected", () => {
  const mw = readFileSync(join(ROOT, "src", "middleware.ts"), "utf8");
  assert.ok(/pathname\.startsWith\("\/api\/"\)/.test(mw), "API paths need their own branch");
  const branch = mw.slice(mw.indexOf('pathname.startsWith("/api/")'));
  assert.ok(/status: 401/.test(branch.slice(0, 300)),
    "a fetch() that follows a 307 gets HTML, and every client error path breaks parsing it");
});

test("security headers are set in middleware and again at the edge", () => {
  const mw = readFileSync(join(ROOT, "src", "middleware.ts"), "utf8");
  for (const h of ["x-content-type-options", "x-frame-options", "referrer-policy", "content-security-policy"]) {
    assert.ok(mw.includes(h), `${h} missing from middleware`);
  }
  const netlify = readFileSync(join(ROOT, "netlify.toml"), "utf8");
  assert.ok(/X-Frame-Options/.test(netlify), "a cached response can bypass middleware");
});

test("REGRESSION: middleware fails closed when the auth service is unreachable", () => {
  const mw = readFileSync(join(ROOT, "src", "middleware.ts"), "utf8");
  assert.ok(/catch/.test(mw) && /auth\.unavailable/.test(mw));
  const guard = mw.slice(mw.indexOf("const isPublic"));
  assert.ok(/if \(!user && !isPublic && !isMachine\)/.test(guard),
    "an auth outage must redirect to login, not admit everyone");
});

test("REGRESSION: the sanitized redirect path is used when bouncing to login", () => {
  const mw = readFileSync(join(ROOT, "src", "middleware.ts"), "utf8");
  assert.ok(/safeRedirectPath\(pathname\)/.test(mw), "`next` is echoed by the callback, so sanitize on the way in too");
});

// ── deployment configuration ────────────────────────────────────────────────
function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...routeFiles(p));
    else if (e === "route.ts") out.push(p);
  }
  return out;
}

test("every route that declares a long maxDuration is configured on the host", () => {
  const vercel = JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8"));
  const configured = new Set(Object.keys(vercel.functions ?? {}));
  const missing: string[] = [];

  for (const f of routeFiles(join(ROOT, "src", "app", "api"))) {
    const src = readFileSync(f, "utf8");
    const m = src.match(/export const maxDuration = (\d+)/);
    if (!m || Number(m[1]) <= 60) continue;
    const rel = f.slice(f.indexOf("src")).replace(/\\/g, "/");
    if (!configured.has(rel)) missing.push(rel);
  }
  assert.deepEqual(missing, [], `these long-running routes are not declared in vercel.json: ${missing.join(", ")}`);
});

test("the Netlify timeout ceiling is documented rather than silently exceeded", () => {
  const netlify = readFileSync(join(ROOT, "netlify.toml"), "utf8");
  assert.ok(/26/.test(netlify));
  assert.ok(/RUNBOOK/.test(netlify), "operators must be pointed at the workaround");
  assert.ok(existsSync(join(ROOT, "docs", "RUNBOOK.md")));
});

test("the build cannot ship with type or lint errors turned off", () => {
  const cfg = readFileSync(join(ROOT, "next.config.js"), "utf8");
  assert.ok(/ignoreBuildErrors: false/.test(cfg));
  assert.ok(/ignoreDuringBuilds: false/.test(cfg));
});

test("REGRESSION: the health check does not use a HEAD request to prove the database works", () => {
  const src = readFileSync(join(ROOT, "src/app/api/health/route.ts"), "utf8");
  // A HEAD request returns no body, so supabase-js has nothing to parse and
  // reports success even when the table does not exist. The check passed
  // against a database with no schema at all until this was found by running it.
  assert.ok(!/head:\s*true/.test(src), "a HEAD probe cannot distinguish an empty schema from a healthy one");
  assert.ok(/PGRST205/.test(src), "a missing schema needs its own diagnosis, not a generic failure");
  assert.ok(/checks\.schema\?\.ok !== false/.test(src), "a missing schema must report down, not degraded");
});

test("REGRESSION: no index expression uses a function Postgres will reject", () => {
  // `array_to_string` is only STABLE - it depends on the element type's output
  // function - so Postgres refuses it in an index expression with 42P17. The
  // whole setup script rolled back on it, and nothing in the test suite or the
  // build could see it, because SQL is only validated when the server runs it.
  const NOT_IMMUTABLE = ["array_to_string", "to_char", "now(", "current_date", "current_timestamp", "age("];
  const dir = join(ROOT, "supabase", "migrations");
  const offenders: string[] = [];

  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql"))) {
    const sql = readFileSync(join(dir, f), "utf8");
    // each CREATE [UNIQUE] INDEX statement, up to its terminating semicolon
    for (const m of sql.matchAll(/create\s+(?:unique\s+)?index[\s\S]*?;/gi)) {
      const stmt = m[0].toLowerCase();
      for (const fn of NOT_IMMUTABLE) {
        if (stmt.includes(fn)) offenders.push(`${f}: ${fn} in ${stmt.split("\n")[0].trim().slice(0, 60)}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `index expressions must be IMMUTABLE:\n${offenders.join("\n")}`);
});

test("REGRESSION: a function whose signature changes is dropped before it is replaced", () => {
  // `create or replace function` cannot change a function's OUT parameters -
  // Postgres raises 42P13 and the whole migration batch rolls back. fn_rebuild_
  // exclusions gained a column in 0003 and took down the entire setup script.
  const dir = join(ROOT, "supabase", "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

  const defs = new Map<string, { file: string; ret: string }[]>();
  const drops = new Map<string, string[]>();

  for (const f of files) {
    const sql = readFileSync(join(dir, f), "utf8");
    for (const m of sql.matchAll(/create\s+or\s+replace\s+function\s+(\w+)\s*\(([^)]*)\)\s*(returns[\s\S]*?)(?:language|as)\s/gi)) {
      const name = m[1];
      const ret = m[3].replace(/\s+/g, " ").trim();
      defs.set(name, [...(defs.get(name) ?? []), { file: f, ret }]);
    }
    for (const m of sql.matchAll(/drop\s+function\s+(?:if\s+exists\s+)?(\w+)/gi)) {
      drops.set(m[1], [...(drops.get(m[1]) ?? []), f]);
    }
  }

  const offenders: string[] = [];
  for (const [name, occurrences] of defs) {
    if (occurrences.length < 2) continue;
    const signatures = new Set(occurrences.map((o) => o.ret));
    if (signatures.size === 1) continue;                  // redefined identically: fine
    const lastFile = occurrences[occurrences.length - 1].file;
    const droppedInOrBefore = (drops.get(name) ?? []).some((d) => d >= lastFile);
    if (!droppedInOrBefore) offenders.push(`${name} changes signature in ${lastFile} with no preceding DROP`);
  }
  assert.deepEqual(offenders, [], offenders.join("\n"));
});

test("the runbook names the conditions under which results should not be trusted", () => {
  const rb = readFileSync(join(ROOT, "docs", "RUNBOOK.md"), "utf8");
  for (const topic of ["PITR", "DATA_REQUIRED", "degraded", "IMPORT_SECRET", "legal opinion"]) {
    assert.ok(rb.includes(topic), `runbook does not cover: ${topic}`);
  }
});

test("REGRESSION: robots.txt is not swallowed by the auth redirect", () => {
  // The middleware matcher excluded images and _next but not .txt, so
  // /robots.txt 307'd to /login. A crawler never reached the Disallow, which
  // defeats the only reason the file exists: keeping the login page out of
  // search results next to the public sixgenrentals.com site.
  const src = readFileSync(join(__dirname, "..", "src", "middleware.ts"), "utf8");
  const m = /matcher:\s*\["([^"]+)"\]/.exec(src);
  assert.ok(m, "the middleware must declare a matcher");
  const re = new RegExp(m![1].replace(/\\/g, "\\"));
  assert.equal(re.test("/robots.txt"), false, "robots.txt must bypass the middleware");
  assert.equal(re.test("/dashboard"), true, "a real page must still be gated");
  assert.equal(re.test("/api/pipeline"), true, "an API route must still be gated");
});

test("REGRESSION: map layers redraw once Leaflet has finished loading", () => {
  // MapView imports Leaflet dynamically, so the map may not exist when data
  // arrives. Each layer effect returns early in that case; without a readiness
  // flag in its deps nothing re-runs it, and the layer never draws. Locally
  // Leaflet was warm and won the race — in production its chunk is a cold fetch
  // while /api/market is fast, so 738 permits arrived first and no pin appeared.
  const src = readFileSync(join(__dirname, "..", "src", "components", "MapView.tsx"), "utf8");
  assert.ok(/setReady\(true\)/.test(src), "map init must signal readiness");

  const deps = [...src.matchAll(/\}, \[([^\]]*)\]\);/g)].map((m) => m[1]);
  const layerDeps = deps.filter((d) => /permits|exclusion|highlight|layers\./.test(d));
  assert.ok(layerDeps.length >= 4, `expected the layer effects, found ${layerDeps.length}`);
  for (const d of layerDeps) {
    assert.ok(/\bready\b/.test(d), `a layer effect does not depend on ready: [${d}]`);
  }
});

test("REGRESSION: candidates and permits are separate map layers", () => {
  // A permit is a constraint that already exists; a candidate is a house you
  // might buy. Drawing them alike, or coupling their toggles, would invite
  // reading a competitor's STR as an opportunity.
  const mv = readFileSync(join(__dirname, "..", "src", "components", "MapView.tsx"), "utf8");
  assert.ok(/candidates: boolean/.test(mv), "the layer must be independently toggleable");
  assert.ok(/g\.current\.candidates/.test(mv), "candidates need their own layer group");
  assert.ok(/layers\.candidates/.test(mv), "the toggle must actually gate the draw");
  assert.ok(!/layers\.permits && layers\.candidates|layers\.candidates && layers\.permits/.test(mv),
    "the two layers must not be coupled");

  const page = readFileSync(join(__dirname, "..", "src", "app", "(app)", "map", "page.tsx"), "utf8");
  assert.ok(/api\/scores\?market=/.test(page),
    "the map must read the same ranking endpoint as Top 25, so they cannot disagree");
  assert.ok(!/Phase 4/.test(page), "the placeholder note must be gone now that candidates render");
});

test("the map surfaces gross yield next to the address, not just the score", () => {
  // A rank alone does not answer "is this worth buying". Yield is revenue over
  // price, so it is the one number that makes a $450k and a $2.1m house
  // comparable at a glance — #1 runs 34.8% while the most expensive runs 7.2%.
  const page = readFileSync(join(__dirname, "..", "src", "app", "(app)", "map", "page.tsx"), "utf8");
  assert.ok(/gross_yield_pct/.test(page), "the list must show yield");
  assert.ok(/forecast_revenue/.test(page), "and the revenue it came from");
  assert.ok(/Sixgen&apos;s own trailing twelve|trailing twelve/.test(page),
    "the panel must say the revenue is modelled from the portfolio, not a market average");
  assert.ok(/before expenses and financing/.test(page),
    "gross yield must be labelled gross — it is not a return");
});

test("hovering the list resizes the pin in place, without redrawing the layer", () => {
  // Rebuilding the candidate layer on every mouse move would close an open
  // popup and flicker. The hover effect swaps icons on existing markers.
  const mv = readFileSync(join(__dirname, "..", "src", "components", "MapView.tsx"), "utf8");
  assert.ok(/hoveredCandidate/.test(mv), "the hovered id must reach the map");
  assert.ok(/setIcon\(/.test(mv), "hover must swap the icon, not rebuild");
  assert.ok(/markers\.current = \{\}/.test(mv),
    "the marker registry must reset on rebuild, or hover resizes a pin that is gone");
});

test("a candidate with no feed URL still opens somewhere useful", () => {
  // The ImagineMLS export has no URL column, so every row today falls back.
  // Silently doing nothing on double-click would read as a broken control.
  const page = readFileSync(join(__dirname, "..", "src", "app", "(app)", "map", "page.tsx"), "utf8");
  assert.ok(/function listingUrl/.test(page));
  assert.ok(/if \(c\.url\) return c\.url;/.test(page), "a real listing URL wins when the feed has one");
  assert.ok(/zillow\.com/.test(page), "and there is a fallback rather than a dead click");
  assert.ok(/est\. revenue/.test(page), "the list must name the revenue, not abbreviate it");
});

test("REGRESSION: the separation circle is coloured by PostGIS, not by browser geometry", () => {
  // Re-deciding eligibility from circle overlap in the browser would be an
  // approximation that can disagree with the screening. It would also be the
  // WRONG test: two 600-ft circles overlapping puts the houses within 1200 ft,
  // which is not a violation of a 600-ft rule.
  const mv = readFileSync(join(__dirname, "..", "src", "components", "MapView.tsx"), "utf8");
  assert.ok(/c\.spacing_result/.test(mv), "the fill must come from the stored spacing result");
  assert.ok(!/intersect|turf|distanceTo\(/i.test(mv),
    "no client-side overlap test may decide the colour");
  assert.ok(/spacingFt \* 0\.3048/.test(mv), "the radius is in feet and Leaflet wants metres");
});

test("REGRESSION: the separation radius comes from str_rules, never a constant", () => {
  // 600 ft still ships marked "(verify)" pending LFUCG Planning. A hardcoded
  // radius would keep drawing the old circle after the rule was corrected.
  const page = readFileSync(join(__dirname, "..", "src", "app", "(app)", "map", "page.tsx"), "utf8");
  assert.ok(/rule_key === "spacing_ft"/.test(page), "the radius must be read from the rules");
  assert.ok(!/radius[^\n]*\b600\b/.test(page), "and not hardcoded");
});

test("REGRESSION: spacing failures reach the map on their own layer", () => {
  // Eligibility gates before scoring, so a listing that fails the separation
  // rule is never in the Top 25. If the map only drew ranked candidates, every
  // circle would be green and "too close to an existing STR" — the state the
  // operator most needs to see — would never render at all.
  const route = readFileSync(join(__dirname, "..", "src", "app", "api", "scores", "route.ts"), "utf8");
  assert.ok(/spacing_result", "FAIL"/.test(route), "the API must return the blocked listings");
  assert.ok(/spacingFailed/.test(route), "under a name the map can read");

  const mv = readFileSync(join(__dirname, "..", "src", "components", "MapView.tsx"), "utf8");
  assert.ok(/blocked = \[\]/.test(mv), "MapView takes them as their own prop");
  assert.ok(/layers\.blocked/.test(mv), "behind their own toggle");

  const page = readFileSync(join(__dirname, "..", "src", "app", "(app)", "map", "page.tsx"), "utf8");
  assert.ok(/blocked: false/.test(page), "off by default — they are rejects, not candidates");
  assert.ok(/setBlocked\(j\.spacingFailed/.test(page), "fed from the API, not recomputed");
});

test("REGRESSION: the Street View key stays server-side and the feature is opt-in", () => {
  // A NEXT_PUBLIC_ key would be inlined into the bundle for anyone to lift and
  // bill. And Street View costs money per request, so an unset key must degrade
  // to the card's no-photo note rather than erroring the page.
  const route = readFileSync(join(__dirname, "..", "src", "app", "api", "streetview", "route.ts"), "utf8");
  assert.ok(/process\.env\.GOOGLE_STREETVIEW_KEY/.test(route), "read from a server-only env var");
  assert.ok(!/NEXT_PUBLIC/.test(route), "never a NEXT_PUBLIC key — that ships the key to the browser");
  assert.ok(/if \(!key\)[\s\S]{0,80}404/.test(route), "no key must 404, not throw");
  assert.ok(/auth\.getUser\(\)/.test(route) && /401/.test(route), "and the proxy is not an open relay");
  assert.ok(/return_error_code/.test(route), "a missing-imagery tile must 404 rather than bill for a grey square");

  const page = readFileSync(join(__dirname, "..", "src", "app", "(app)", "map", "page.tsx"), "utf8");
  assert.ok(/onError=\{\(\) => setNoImage\(true\)\}/.test(page), "the card falls back when no photo loads");
});

test("REGRESSION: the Top 25 row offers a visible way to open the listing", () => {
  // The double-click gesture shipped with nothing on screen advertising it.
  const page = readFileSync(join(__dirname, "..", "src", "app", "(app)", "map", "page.tsx"), "utf8");
  assert.ok(/See it on Zillow|Open listing/.test(page), "a labelled link, not just a gesture");
  assert.ok(/rel="noopener noreferrer"/.test(page), "opened safely in a new tab");
});
