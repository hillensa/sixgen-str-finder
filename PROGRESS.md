STATUS: BLOCKED — 742 duplicate permit rows need deleting from production; recommended answer: yes, keep the oldest row per permit_number

## Goal

Sixgen STR Finder screens Lexington, KY homes for sale as short-term-rental
acquisitions. It imports a weekly MLS export, geocodes and links each listing to
its Fayette County parcel and zoning, screens it against LFUCG's STR rules
(600-ft separation from an existing permitted STR, zoning treatment, HOA),
forecasts revenue from Sixgen's own 17-property trailing twelve, ranks what
survives, and draws the result on a map at https://strmap.sixgenrentals.com.
The invariant the whole thing is built on: **unknown blocks, it never clears** —
nothing is marked eligible because a field was empty.

## Checklist

- [x] Phase 1-6 — schema, permits, GIS, eligibility, forecasting, scoring
- [x] Deploy to Vercel at strmap.sixgenrentals.com (DNS at Google Cloud DNS)
- [x] Reconcile 738 permits against LFUCG — 738/738 matched, 0 missing, 0 extra
- [x] Census + LFUCG address-point geocoding on the listings import
- [x] Parcel/zoning cache so `fn_link_properties_to_parcels` has data to match
- [x] RESO Web API adapter (`src/lib/providers/reso.ts`) — built, unused, see below
- [x] Weekly MLS export path: file button on /admin, Windows-1252 fallback
- [x] Import 162 real ImagineMLS listings (161 LFUCG geocode, 1 Census, 0 failed)
- [x] Top 25 layer on the map, toggleable
- [x] Layers panel bottom-left; Top 25 list down the right edge with gross yield
- [x] Hover a row to grow its pin on the map
- [x] Separation circles — green PASS / yellow FAIL, filled from PostGIS
- [x] "Blocked by proximity" layer for the 37 listings spacing rules out
- [x] Hover card: beds, baths, sqft, year, lot, $/sqft, DOM, revenue, yield
- [x] Visible "See it on Zillow" link on each Top 25 row
- [x] `/api/streetview` proxy — dark until `GOOGLE_STREETVIEW_KEY` is set
- [x] Make the Top 25 list collapsible
- [x] Test Address: draw the existing STRs, the separation ring, and distances
- [x] Fix permit refresh keying on unstable ArcGIS ObjectIDs (dc24ffc)
- [ ] Delete the 742 duplicate permit rows (needs Seth's yes — see Blockers)
- [ ] Re-link parcels, re-apply blocking rules, rebuild exclusion, re-screen listings
- [x] Import Zillow "Lexington with pool" search, page 1 (41 homes, with photos + links)
- [x] Fold duplicate listings so each house is scored and listed once (a00771c)
- [x] Weekly Zillow pull: `zillow` provider, extractor, checksum-verified import (34e56fc)
- [x] First weekly-criteria pull: 41 of 113 (Zillow challenged page 2) — partial import
- [x] Scheduled task `sixgen-weekly-zillow-pull`, Mondays 7:08 AM local
- [x] Existing STRs layer: legible dots + a swatch per layer; /api/market pages past 1000 rows (f00df78)
- [x] Zillow Pull page: saved beds/baths, Pull from Zillow, Send to Sixgen bookmark, paste + import (122e4a0)
- [x] Weekly task + script read the saved search from app_settings
- [x] Server Supabase clients bypass Next's fetch cache — health was replaying a Sept read (2c2bdd3)
- [ ] Seth: drag the Send to Sixgen bookmark to the bookmarks bar, then do one pull from /zillow
- [ ] Seth: complete Zillow's Press & Hold in the Browser pane, then "Run now" on the task
- [ ] Decide whether to retire the September MLS listings (162 rows, provider csv)
- [ ] Decide the photo source — Street View key, or re-cut the export (below)
- [ ] Resolve whether an LFUCG permit survives a sale (below)
- [ ] Confirm the 600-ft rule and zoning treatments with LFUCG Planning

## Decisions & assumptions

- **Weekly manual export, not the Spark API.** Spark costs $50/mo. Seth exports
  from ImagineMLS (flexmls) instead and uploads the CSV on /admin. The RESO
  adapter is built and tested so the API path is a config change if that flips.
- **Eligibility gates ranking; it never scores into it.** A RED property is
  recorded with its gate reason and no score. Consequence worth knowing: all 25
  ranked candidates PASS spacing, so the Top 25 can only ever draw green
  circles. The 37 spacing failures live on their own layer, off by default.
- **Circle fill comes from the stored PostGIS `spacing_result`**, never from
  browser circle geometry. Two 600-ft circles overlapping means the houses are
  1200 ft apart, which breaks no rule — the overlap test would be wrong as well
  as approximate. A regression test forbids reintroducing it.
- **`hoa_rule` defaults to `VERIFIED_NO_HOA_ONLY`**, and nothing can be verified
  from a feed, so `qualified: 0` is correct, not a bug. `hoaStatusFrom` never
  returns VERIFIED_NO_HOA from feed data; `AssociationYN: false` means unknown.
- **Street View is opt-in.** No `GOOGLE_STREETVIEW_KEY` means /api/streetview
  404s, the card shows a no-photo note, and Google is never called or billed.
  The key is deliberately NOT `NEXT_PUBLIC_` — that ships it to the browser.
- **Two different distances, both shown, never conflated.** The 600-ft rule is
  measured property line to property line in PostGIS and is what governs. It
  also stops looking at the rule distance, so a passing address reports no
  nearest-STR distance — which is why /test-address additionally computes
  straight-line house-to-house distances in `src/lib/gis/distance.ts`. Every
  surface that shows those labels them as straight-line; a regression test
  enforces it. Upgrading them to parcel-edge needs a new PostGIS function and a
  migration (this machine has no DB connection string — DDL goes through the
  Supabase SQL editor).
- **Zillow is the weekly source; it is not fully automatic.** Zillow's bot
  protection (PerimeterX) challenged the in-app browser after a handful of
  page loads — first a scripted fetch, then a "Next page" click, then any load
  (HTTP 403). The weekly task stops at a challenge, imports what it verified as
  a PARTIAL (no listing retired), and asks Seth to press-and-hold and re-run.
  It never attempts the challenge. If partial runs become the norm, stale
  Zillow listings are never retired — fall back to the ImagineMLS export.
- **Zillow's "HOA <= $0" filter includes homes with no HOA data**, which is most
  Lexington single-family listings. In the app they stay HOA_UNKNOWN; nothing
  from a feed is treated as verified no-HOA.
- **On-demand Zillow pulls run in Seth's own browser.** The /zillow page opens
  the saved search; a bookmarklet copies each rendered results page; pasting on
  /zillow collects them; /api/zillow/import enforces: Zillow's filters must equal
  the saved search, rows re-checked against the minimums, Fayette-County
  coordinates only, photos only from photos.zillowstatic.com, URLs rebuilt from
  the zpid, full sync only for a complete pull. The bookmark reloads a page
  Zillow changed in place rather than re-copying the wrong page.
- **The saved search lives in app_settings (`zillow_search`)** and drives both the
  on-demand page and the Monday task.
- **Server-side Supabase reads never use Next's fetch cache** (`noStoreFetch`).
  Next cached the health check's GETs for a year, on Vercel across deploys.
- **One listing per house.** A house in both the MLS export and Zillow is
  folded to its most recently seen listing before scoring and display.
- **`fullSync` defaults to false** on refresh. It defaulted true in Phase 1 and
  a five-row correction marked every other listing in the market as removed.
- Seeded zoning treatments and the 600-ft citation are marked "(verify)". The
  density rule ships disabled.

## Blockers

**0. Duplicate permit rows (2026-11-07).** Running `/api/refresh` today doubled
`str_permits` from 738 to 1484 rows: LFUCG republished its layer, ObjectIDs
renumbered, and the upsert keyed on them. Code is fixed (`dc24ffc`); the data is
not. Backup of all 1484 rows:
`C:/Users/hille/AppData/Local/Temp/claude/00f1a328d35bae88/0d97c7ac-3001-40b8-9577-d55e469f5103/scratchpad/str_permits_backup.json`
Dry run: keep the oldest row per `permit_number` (742 kept, 742 deleted, 0
permit numbers lost, the 8 genuinely new STR-26 permits kept), clear the false
"No longer present" note on 253 kept rows, then run
`fn_link_permits_to_parcels`, `fn_apply_blocking_rules`,
`fn_rebuild_exclusions` and re-screen. The map's buffer geometry is barely
affected (duplicates sit on the same spots); counts and density are.

Two further decisions only Seth can make:

1. **Photos.** `primary_photo` is null on all 162 rows — the ImagineMLS export
   view has no image field and no listing URL. Either (a) add
   `GOOGLE_STREETVIEW_KEY` in Vercel as **Config, not Secret** (enable Street
   View Static API in Google Cloud, restrict the key to that one API, no HTTP
   referrer restriction — it is called server-side), or (b) re-cut the export
   view to include a photo URL field if ImagineMLS offers one. (b) gives real
   listing photos and is free; some MLSs block photo URLs for licensing.
2. **Does an LFUCG STR registration survive a sale?** Three listings sit 3 ft
   from a permit at their own address — they look like permitted STRs being
   sold, which is arguably the best kind of candidate, but they are currently
   gated as "too close to an existing STR". The map popup flags them for review
   rather than resolving it. If registrations do not transfer, the current
   gating is wrong and spacing should ignore a permit on the subject parcel.

## How to resume

**Repo:** `C:\Users\hille\sixgen-str-finder` (moved here from a 264-char path
that defeated git on Windows MAX_PATH — do not move it back). Branch `main`,
pushes auto-deploy to Vercel.

**Read first:** `docs/DEPLOY.md` (runbook plus a "Traps this deployment actually
hit" section), `docs/RUNBOOK.md`, `docs/IMPLEMENTATION_PLAN.md`.

**Stack:** Next.js 14 App Router, TypeScript strict, Tailwind, Leaflet (dynamic
import), Supabase (Postgres + PostGIS + RLS + magic-link auth). Spatial work is
SRID 2246 (KY North, US survey feet). GIS overlays come from LFUCG ArcGIS
FeatureServers.

**Commands:**

```bash
npm test                 # 266 tests, node:test via tsx
npx tsc --noEmit         # strict typecheck
npm run dev              # dev server
npm run build            # production build
```

**Never run `npm run build` while a dev server is running** — they share `.next`
and it corrupts. This has bitten twice. Kill the dev server first.

**Current data:** 158 properties, 162 active listings, 738 permits, 17 Sixgen
properties, 162 scores. 35 ranked, 127 gated. Spacing: 125 PASS, 37 FAIL.

**Weekly Zillow pull:** the task prompt is at
`C:/Users/hille/.claude/scheduled-tasks/sixgen-weekly-zillow-pull/SKILL.md`.
By hand: `python scripts/zillow_weekly.py url`, open it in the Browser pane, run
`scripts/zillow_extract.js` in the page for each results page, write each `psv`
to `data/zillow/<date>/p<N>.psv`, `python scripts/zillow_weekly.py verify <file> <sha>`,
then `python scripts/zillow_weekly.py import data/zillow/<date> --expected-total <N>`.
Run data is gitignored.

**To refresh listings from the MLS instead:** export from https://imagine.flexmls.com/ using the
saved search (Lexington, >= $400k, 4+ bed, 3+ bath, single-family, no HOA), then
upload the CSV with the "Weekly MLS export" button on `/admin`. The export is
Windows-1252, not UTF-8, and flexmls publishes decimals into integer columns —
both are already handled on the import path. Then re-run forecasts and scoring.

**Env:** `.env.local` is gitignored and excluded from every packaged zip. The
service role key bypasses all RLS and is server-only. In Vercel, env vars must
be type **Config**, never **Secret** — Secret is write-only, unreadable at build
and at runtime, which breaks `NEXT_PUBLIC_*` inlining and 500s every route.

**Working style Seth has asked for:** keep going without checking in on
reversible decisions; stop only for things only he can do. Never ask him to
paste a key into chat — clipboard hand-off only.
