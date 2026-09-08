# Sixgen STR Finder

Internal acquisition-intelligence platform for Sixgen Rentals. Answers one question:
**which homes for sale in Lexington are the best un-hosted STR acquisitions**, given the
600-ft separation rule, zoning, HOA status, Sixgen's own operating history, and price.

**Status: Phase 7 (Production Launch) complete — all seven phases delivered.** See `docs/IMPLEMENTATION_PLAN.md` for all
seven phases, architecture, and the engineering decisions made along the way.

## What works today (all phases)

| Area | Status |
|---|---|
| Invite-only login (magic link; DB trigger rejects uninvited emails; first user = admin) | ✅ |
| PostGIS schema — 35 normalized tables, spatial indexes, RLS, versioned `str_rules` | ✅ |
| PostGIS functions: `fn_spacing_test`, `fn_density_test` (returns `DATA_REQUIRED` honestly), `fn_apply_blocking_rules`, `fn_rebuild_exclusions`, `fn_parcel_at`, `fn_zoning_at`, `fn_parcel_candidates`, `fn_permit_match_report` | ✅ |
| Admin → **STR Rules** editor (spacing, density, zoning treatment, occupancy ceiling; effective dates; versions) | ✅ |
| Lexington map with existing STRs, 600-ft exclusion, parcels, zoning, county boundary — toggleable | ✅ |
| Click any point → parcel + zoning probe (LFUCG GIS, cached in Postgres) | ✅ |
| **Test Any Address** → geocode (E911) → parcel → zoning → treatment | ✅ |
| City GIS sync (permits → parcels → blocking rules → dissolved exclusion in PostGIS) | ✅ |
| **Permit import wizard** — CSV/TSV/XLSX upload, worksheet + header-row picker, column mapper with composite-address support, live preview | ✅ |
| **Geocoder** — LFUCG `Address_Point` exact → fuzzy → US Census fallback, cached in `geocode_cache`, confidence reported honestly | ✅ |
| **Match report** — matched / possible / unmatched / duplicate / invalid, with a per-row manual-fix panel (re-geocode, coordinates, parcel picker, type, status) | ✅ |
| **Blocking flag is data, not code** — derived from `str_rules`; unknown type or status blocks by default | ✅ |
| 600-ft buffer via `ST_Buffer` on the parcel in SRID 2246, dissolved with `ST_Union` into `market_exclusions` | ✅ |
| `ListingsProvider` interface with CSV + JSON providers; RESO stub | ✅ |
| Hard acquisition filters (4+ bd · ≥$400K · HOA tri-state) — pure, unit-tested | ✅ |
| Revenue formula, scenarios, monthly reconciliation — unit-tested | ✅ |
| Netlify + Vercel configs | ✅ |
| **Eligibility engine** — zoning treatment · 600-ft separation · density · HOA → GREEN / YELLOW / RED | ✅ |
| **Test Address** returns a full screen with every reason spelled out, measured from the parcel boundary | ✅ |
| **Re-run eligibility** (Admin) — links parcels, re-screens the market, stamps `rules_version` on every row | ✅ |
| **🔄 Refresh Lexington listings** — diff engine: new · price change · relisted · status · removed, each with a reason | ✅ |
| **All Listings** page — 12 optional filters, 9 sorts, paging, eligibility on every row | ✅ |
| Price history appended on every observed price move; `previous_price` and `price_changed_at` on the listing | ✅ |
| Properties have an identity (`market · address · unit`), so a re-list or a second provider updates one house | ✅ |
| Re-screens eligibility only for properties that newly entered the pool | ✅ |
| **Sixgen comparable engine** — similarity on beds · sleeps · baths · amenities, weighted by how much of the year each comp traded | ✅ |
| **Forecasts** — conservative / base / upside from observed comp dispersion, occupancy capped by rule, monthly curve from the portfolio's own seasonality | ✅ |
| **Confidence** — HIGH / MEDIUM / LOW from comp count, closeness, bedroom match and year coverage, with the reasons attached | ✅ |
| **Sixgen Comps** page — model any hypothetical property against the portfolio and see exactly which listings drove the number | ✅ |
| Guesty portfolio import (CSV/XLSX), append-only history, trailing-twelve aggregation | ✅ |
| **Acquisition score** — eligibility gates first, then eight weighted factors read from `scoring_weights` | ✅ |
| **Top 25** — ranked table with a per-property score breakdown, plus “Needs HOA Verification” and “Requires Review” lists | ✅ |
| **Property page** — forecast, eligibility with reasons, comps, map, price history, notes | ✅ |
| **Editable pro forma** — NOI, cap rate, DSCR, cash-on-cash, break-even occupancy; every line shows its basis | ✅ |
| **Amenity upside** — hot tub / golf sim / game room / fire pit / extra bedroom, ranked by payback | ✅ |
| **Pipeline** board, saved properties, per-property notes | ✅ |

## Run it

```bash
cp .env.example .env.local        # fill in Supabase values
npm install
npm test                          # 190 tests
npm run dev                       # http://localhost:3000
```

**Supabase setup (once):** SQL Editor → run `supabase/migrations/0001_foundation.sql`,
then `0002_functions.sql`, `0003_phase2.sql`, `0004_phase3.sql`, `0005_phase4.sql`, `0006_phase5.sql`, `0007_phase6.sql`, then `seed.sql` (edit the email on the
last line first). 0003 adds the unique keys the seed depends on — run it before re-seeding,
or the seed will duplicate every rule.
Authentication → URL Configuration → add your site URL and `/auth/callback`.

**First data load:** sign in → Admin → **Sync city data now** (≈30 s). Then open Map.

Optional: paste `supabase/tests/spatial.sql` into the SQL editor to verify the PostGIS
spacing math at 599 / 601 ft. It rolls back automatically.

## Importing the city permit file

**Data → Import STR permits** (admin only), or go straight to `/data/permits`.

1. Drop in the ORR spreadsheet. Pick the worksheet, and the header row if the
   file has a title above it.
2. Confirm the column mapping. Nothing is assumed — the 2026 tab's five address
   columns and the 2024 tab's single `Property Address` column both work, and the
   preview shows exactly what will be written.
3. Import. Every row is geocoded (city address points first, Census only as a
   fallback), matched to a parcel in PostGIS, and recorded in `import_rows` with
   its outcome.
4. Work the match report. Anything short of an exact address-point hit lands in
   **possible** or **unmatched** for you to fix. A manual fix is stamped
   `match_method = 'manual'` and the next city sync will not overwrite it.
5. Rebuild the exclusion when you have finished fixing rows.

**Running it for real:** see [docs/RUNBOOK.md](docs/RUNBOOK.md) — load order, the
long-running-import problem on Netlify, monitoring, backups, and the conditions
under which results should not be trusted.

## Deploy (Netlify)

1. Push to GitHub. 2. Netlify → Add new site → Import from Git.
3. Build command `npm run build`, publish `.next` (the `netlify.toml` sets this).
4. Add the four env vars from `.env.example`. 5. Deploy, then add the Netlify URL to Supabase Auth URLs.

## Project layout

```
supabase/migrations/   0001 schema · 0002 spatial fns · 0003 permit import + rule-driven blocking
                       0004 eligibility engine · 0005 listings engine + property identity
                       0006 Sixgen comps + forecasts · 0007 scoring, pro forma, pipeline
supabase/tests/        spatial.sql (PostGIS boundary test)
src/lib/               filters · revenue · rules · eligibility · arcgis · address · geocode
                       listings/{diff,query,refresh} · comps/engine · import/sixgen
                       scoring/score · proforma · log · rateLimit · safeRedirect
                       xlsx · safeRedirect
                       gis/parcel · import/{columns,permits,readFile} · providers/listings
src/app/(app)/         dashboard map top25 listings test-address pipeline comps admin
                       data · data/permits (wizard) · data/permits/[id] (match report)
                       property/[id] (detail + pro forma)
src/app/api/           market search overlay gis/parcel-at rules refresh invite notes health
                       imports/permits/{analyze,commit} · imports/[id] · permits/[id]
                       exclusions/rebuild · eligibility/{check,rerun}
                       listings · listings/refresh · listings/import
                       sixgen/import · forecasts · scores · properties/[id] · pipeline
tests/                 filters · revenue · gis · permits · address · import · xlsx
                       spatial · redirect · eligibility · listings · comps · scoring
                       api-auth · hardening
docs/                  IMPLEMENTATION_PLAN.md · RUNBOOK.md (operator guide)
```

## Sixgen data included

`data/sixgen/` — all 17 Lexington properties and 24 months of monthly performance from Guesty
(2,417 reservations, host-payout basis). T12: $2.34M · 71.0% occ · $530 ADR. See its README for caveats.

## Data honesty rules baked in

- **Every permitted STR is always shown on the map** — all types, all sizes. Enforced by `tests/permits.test.ts`; listing filters can never touch permit data. Records the city publishes without geometry are imported as `unlocated`, not dropped.
- **Unknown blocks; it never clears.** A permit whose hosted/un-hosted value or status cannot be read counts toward the separation rule, and `blocking_reason` records why.
- **A sync refuses to publish an empty exclusion.** If no permit qualifies as blocking, `/api/refresh` returns 409 instead of quietly clearing the map.
- **Only an exact city address-point hit is `matched`.** A fuzzy hit is `possible`; a Census interpolation never scores above 0.7.
- **GREEN means “every check this tool can make passed”, never “legal”.** Anything unverified — HOA, an unmatched parcel, a separation measured from a permit point, a zone with no treatment configured — forces YELLOW with the reason attached.
- **“No rule configured” and “rule in force, data missing” are different answers.** The density test returns `NOT_CONFIGURED` for the first (Lexington today) and `DATA_REQUIRED` for the second. Only the second is a caveat on a property.
- **Every screen stamps `rules_version`.** Change a rule and the old results read as stale rather than being silently re-interpreted.
- **A partial refresh never removes anything.** Marking absent listings as removed requires an explicit full-sync opt-in, because a five-row paste is not evidence that the rest were withdrawn.
- **A refresh that receives zero listings is refused.** An empty provider response can only destroy data, so it is treated as an error rather than a market with no houses in it.
- **One house is one property.** Listings are matched to an existing property by canonical address, then by coordinates within 60 ft, before a new one is created.
- **Occupancy from Guesty is a floor, not a rate.** It is measured against calendar days; owner and maintenance blocks are invisible in the export. Every forecast says so.
- **A listing's pre-launch zeros are not vacancy.** Comps are built on trailing twelve months and weighted by the months a listing actually traded, so a mid-window launch cannot drag the market down.
- **A forecast with no comparable is a refusal, not a zero.** If nothing in the portfolio is close enough, the engine says so instead of returning $0 as though it were a finding.
- **Eligibility gates the ranking; it is not a factor in it.** A property that fails a rule is excluded outright with its reason, because a mid-table score invites trading “illegal” off against “high yield”.
- **A missing input redistributes its weight; it never scores zero.** A property with no square footage is not a bad property, and the score says which factors it could not use.
- **Every score keeps the weights it was computed under**, so a past ranking stays explainable after someone retunes them.
- **`/api/health` reports degraded when the exclusion zone goes stale**, because a fresh-looking screen run against fortnight-old permits is the failure mode that actually costs money.
- **An error page never implies the app still works.** It says nothing was saved and that results on the page should not be relied on.
- **Logs redact anything credential-shaped** — by substring, so `SUPABASE_SERVICE_ROLE_KEY` and `IMPORT_SECRET` are caught, while `rule_key` and `zone_code` still log.
- **The post-login `next` parameter is sanitized, not trusted.** `safeRedirectPath` allows only same-origin, single-slash paths, and the callback resolves them with the `URL` constructor instead of string concatenation.

- HOA is `HOA_UNKNOWN` unless a source proves otherwise; `$0 fee` is **not** proof.
- Density returns `DATA_REQUIRED` until dwelling-unit denominators exist — never a fake percentage.
- Every eligibility check will stamp `rules_version`; every forecast stamps `model_version`.
- Zoning treatment comes from `str_rules`, not code. The 1,000-ft density rule ships **disabled** pending ordinance confirmation.

> Sixgen STR Finder is an acquisition-screening tool. Final STR eligibility must be confirmed
> with Lexington-Fayette Urban County Government Planning and applicable legal professionals.
