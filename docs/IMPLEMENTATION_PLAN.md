# Sixgen STR Finder — Implementation Plan

**Product:** Sixgen STR Finder (Sixgen Acquisition Intelligence)
**Market 1:** Lexington-Fayette County, KY  ·  **Architecture:** multi-market from day one
**Status:** Phase 1 delivered (this document + code). Phases 2–7 scheduled.

---

## 0. What I reviewed before designing

| Input | What it tells us |
|---|---|
| **ORR-2026-1259 STR spreadsheet** (3 year-tabs) | 2026 tab: 1,012 rows, columns = Owner Name, Hosted/Unhosted, Owner(s), Occupation License #, STR License #, Street Number, Unit, Direction, Street Name, Suffix, Zip, Emergency Contact, Phone, Insurance Expiration, Notes. Address is **split across 5 columns** — the import wizard must support composite address mapping. 2024 tab uses a single "Property Address" column — proves column names vary year to year, validating the "don't assume columns" requirement. |
| **LFUCG ArcGIS org** `services1.arcgis.com/Mg7DLdfYcSWIaDnu` | Layers confirmed live: `Short_Term_Rental_Public_view` (734 pts, fields `address`, `hosted__unhosted`, `license_number`), `Parcel` (polygons, `ADDRESS`), `Zoning` (`ZONING` coded domain, `LINK` to ordinance), `Address_Point` (E911, `ADDRESS`, `STADD`, `STNAME`, `TYPE`), `Fayette_County`, `Urban_Service_Area`, `Building`. Native SRID **2246** (KY North, US survey ft) — ideal for foot-based math. |
| **Sixgen Guesty data** | 17 Lexington listings; trailing-year host payout pulled for 7 (4–7 BR, $72K–$222K, 58–74% occ). Guesty is connected as an MCP connector → Phase 5 can import via API rather than only CSV. |
| **Wheelhouse market 521** | Lexington 4+BR ADR percentiles and CON/REC/AGG seasonality curve (Keeneland Apr/Oct peaks). Supporting reference for revenue confidence, not the primary model. |
| **Prior build** (`strmap`) | Working Next.js 14 + Supabase app with invite-only auth, live-GIS 600-ft engine, Zillow snapshot import, HOA screen, revenue model, Top 25. **Reused as the Phase 1 foundation** rather than rebuilt. |

---

## 1. Architecture

```
┌───────────── Browser (Next.js App Router, React, Tailwind) ─────────────┐
│ Dashboard · Map (Leaflet) · Top 25 · Listings · Test Address · Pipeline │
│ Sixgen Comps · Data (import wizards) · Admin (rules, weights, sources)  │
└──────────────────────────┬──────────────────────────────────────────────┘
                           │ fetch /api/*  (session cookie, RLS-scoped)
┌──────────────────────────▼──────────────────────────────────────────────┐
│ Next.js Route Handlers (server)                                          │
│  • ListingsProvider (CsvProvider | JsonProvider | future MLS/RESO)       │
│  • LFUCG GIS client (parcel / zoning / permits / address points)         │
│  • Import pipeline (column mapping → normalize → geocode → parcel match) │
│  • Eligibility engine  → calls PostGIS functions                         │
│  • Revenue engine (comparable-property model, versioned)                 │
│  • Scoring engine (weights from DB)                                      │
└──────────────────────────┬──────────────────────────────────────────────┘
                           │ service-role (writes) / anon+RLS (reads)
┌──────────────────────────▼──────────────────────────────────────────────┐
│ Supabase Postgres + PostGIS                                              │
│  geometry(…,4326) columns + generated geometry(…,2246) for foot math     │
│  fn_nearest_blocking_str · fn_spacing_test · fn_density_test            │
│  fn_zoning_at · fn_parcel_at · materialized eligibility results         │
└─────────────────────────────────────────────────────────────────────────┘
```

**Authoritative GIS math lives in PostGIS** (SRID 2246, feet). Turf.js is used only for client-side visualization. This replaces the prior build's in-app buffering for anything that produces a legal-screen result.

---

## 2. Engineering decisions (made, documented, not blocking)

| Decision | Choice | Why |
|---|---|---|
| Hosting | **Netlify** (spec) — `netlify.toml` included; `vercel.json` retained so either works | Next.js runs on both; no lock-in |
| Map library | **Leaflet** for Phase 1–6; MapLibre migration is a Phase 7 option | Leaflet is proven in the prior build, no API key, and parcel/zoning overlays are viewport-scoped so performance is fine. MapLibre only pays off with vector tiles for full-county parcel rendering. Map component is isolated (`MapView.tsx`) so the swap is contained. |
| UI kit | Tailwind + hand-built shadcn-style primitives (`components/ui`) | shadcn CLI needs network at scaffold time; identical patterns, zero runtime difference |
| GIS math | **PostGIS functions**, SRID 2246 | Spec §7 requirement; deterministic, indexed, testable in SQL |
| Listings | `ListingsProvider` interface; **CsvProvider + JsonProvider** ship at launch | Spec §11/§47. No scraping. The browser-assisted export from the prior build is retained only as a manual JSON export the operator runs in their own session; it is not invoked by the server. |
| Density denominator | Uses LFUCG `Address_Point` residential count (TYPE='R') within radius **only when the layer is populated**; otherwise returns `DATA REQUIRED` | Spec §8 — never fake the denominator |
| Legal rule values | Stored in `str_rules`, versioned; 600-ft spacing seeded **enabled**; 1,000-ft density seeded **disabled** with note "confirm threshold with LFUCG before enabling" | I have direct evidence for 600 ft; I do not independently verify the density percentage, so the app must not assert it by default |
| Auth | Supabase magic-link, DB-trigger allowlist, first user = admin | Already built and verified |

---

## 3. Phases

### Phase 1 — Foundation ✅ (delivered now)
- App shell with left nav (Dashboard, Map, Top 25, All Listings, Test Address, Pipeline, Sixgen Comps, Data, Admin)
- Auth, profiles, invite allowlist (carried forward)
- **PostGIS schema v2** — 26 normalized tables, spatial indexes, RLS, versioned rules
- **STR Rules Engine** table + Admin editor (spacing, density, zoning treatment, occupancy ceiling)
- Lexington map with parcel + zoning overlays (carried forward, viewport-scoped)
- **Parcel/zoning integration**: `POST /api/gis/parcel-at` → matches a point to its LFUCG parcel + zoning, caches both in `parcels` / `zoning_districts`
- **Test Address v1**: address autocomplete → parcel → zoning (spacing/density wired in Phase 3)
- Hard acquisition filters as a pure, tested module (4+ bd, ≥$400K, HOA tri-state)
- Test harness (`node:test` via tsx — runs with zero extra deps) with GIS, filter, and revenue formula tests
- Netlify + Vercel configs, `.env.example`, docs

### Phase 2 — Existing STR Permit Map ✅ (delivered)
- Import wizard: CSV/XLSX upload → column mapper (supports composite addresses, e.g. the ORR file's 5 address columns) → normalize → geocode via LFUCG `Address_Point` (Census fallback) → parcel match with confidence score
- Match report: matched / possible / unmatched / duplicate / invalid, with manual-fix UI
- Permits rendered on map from PostGIS; blocking-permit flag derived from rules (un-hosted + active)
- 600-ft buffer layer computed by `ST_Buffer(parcel_geom_2246, spacing_ft)` and dissolved (`ST_Union`) into `market_exclusions`

**What shipped**

| Piece | Where |
|---|---|
| XLSX reader (ZIP + OOXML, no dependency) and CSV/TSV reader | `src/lib/xlsx.ts`, `src/lib/import/readFile.ts` |
| Address normalization, composite assembly, similarity | `src/lib/address.ts` |
| Column detection, validation, warnings, value coercion | `src/lib/import/columns.ts` |
| Row normalization and duplicate detection | `src/lib/import/permits.ts` |
| Geocoder: address-point exact → fuzzy → Census, cached | `src/lib/geocode.ts`, table `geocode_cache` |
| Wizard, match report, manual-fix panel | `src/app/(app)/data/permits/` |
| analyze / commit / report / fix / rebuild endpoints | `src/app/api/imports/*`, `api/permits/[id]`, `api/exclusions/rebuild` |
| Rule-driven blocking flag | `fn_apply_blocking_rules` (migration 0003) |

**Four Phase 1 defects fixed here, because Phase 2 sits directly on them**

1. **`p.hosted === "U"` in the sync route.** An exact single-character comparison
   against the city's `hosted__unhosted` field, with no fallback and no assertion
   that anything matched. Had LFUCG published `"Unhosted"` rather than `"U"`,
   every permit would have been stored `is_blocking = false`, the exclusion would
   have been empty, and every address in the county would have returned PASS —
   silently. Replaced by `parseStrType` (handles both encodings, returns `null`
   rather than guessing) plus `fn_apply_blocking_rules`; `/api/refresh` now
   refuses to rebuild from zero blocking permits.
2. **`distinct on (coalesce(pc.id, sp.id))` in `fn_rebuild_exclusions`.**
   `parcels.id` and `str_permits.id` are independent sequences, so a permit id
   could collide with a parcel id and silently drop a real 600-ft buffer. The
   dedupe key is now namespaced (`'p'||id` vs `'s'||id`).
3. **`ringsToMultiPolygon` treated every ArcGIS ring after the first as a hole.**
   A two-part parcel became one part with a hole punched through it — and that
   wrong footprint is what `ST_Buffer` used. Rings are now split on winding
   (ArcGIS exterior = clockwise) and emitted with RFC 7946 orientation.
4. **The city sync reset `match_status` to `unmatched` on every run** while
   `fn_link_permits_to_parcels` skipped rows whose `parcel_id` was already
   correct — so a matched permit stayed labelled unmatched forever, and manual
   corrections were overwritten. Both were rewritten; `match_method = 'manual'`
   is now never touched by a sync.

`str_rules` and `zoning_districts` also gained the unique keys their `on conflict`
clauses assumed. Migration 0003 de-duplicates existing rows before adding them.

**Deferred deliberately:** the map still renders permits from the same
`/api/market` payload as Phase 1 (now carrying `blocking_reason` and
`match_status`). Per-status map styling belongs with the Phase 3 eligibility
colours rather than here.

### Phase 3 — Eligibility Engine ✅ (delivered)
- `fn_spacing_test(parcel)` → nearest blocking STR, distance ft, PASS/FAIL, which STR caused it
- `fn_density_test(parcel)` → units, STRs, %, projected %, threshold, PASS/FAIL/**DATA REQUIRED**
- Zoning treatment lookup from `str_rules` (principal / accessory / conditional / prohibited / review)
- HOA tri-state (VERIFIED_NO_HOA / HOA_PRESENT / HOA_UNKNOWN)
- Classification GREEN / RED / YELLOW with `eligibility_failures` rows explaining each reason
- Rules version stamped on every `eligibility_checks` row; "re-run all" admin action

**What shipped**

| Piece | Where |
|---|---|
| `eligibility_facts` composite type — one shape, every caller | migration `0004_phase3.sql` |
| `fn_eligibility_facts` (+ `_for_parcel`, `_at_point`, `_for_properties`) | `0004_phase3.sql` |
| `fn_zoning_treatment` — effective-dated treatment lookup | `0004_phase3.sql` |
| `fn_link_properties_to_parcels` — parcel-edge measurement needs it | `0004_phase3.sql` |
| `v_property_eligibility` (latest per property) + `fn_eligibility_summary` | `0004_phase3.sql` |
| GREEN / YELLOW / RED classifier and reason rows | `src/lib/eligibility.ts` |
| Ad-hoc screen (no write) and batch re-run (writes) | `src/app/api/eligibility/{check,rerun}` |
| Full screening UI with blocking vs. verification panels | `src/app/(app)/test-address/page.tsx` |
| Re-run action + live counts | Admin → *1b · Re-run eligibility* |

**Where the decision logic lives.** PostGIS returns facts; `src/lib/eligibility.ts`
turns them into a classification. That keeps the geometry indexed and correct in
the database while the judgement stays pure and unit-tested — 26 tests cover it,
and both the ad-hoc check and the batch re-run call the same function, so the
Test Address page can never disagree with the Top 25.

**Decisions taken with the operator (2026-09-04), all recorded as defaults:**

1. Separation is measured **parcel line to parcel line**. A property with no
   parcel match is screened from its geocoded point and downgraded to YELLOW
   with `PARCEL_NOT_MATCHED` rather than being reported as exact.
2. Only **un-hosted** permits block, per the seeded `spacing_ft` rule's
   `applicable_str_type`. A permit whose type could not be read still blocks
   (Phase 2's fail-safe), so it is counted here too.
3. The **density rule stays off**. See the correction below.
4. A **conditional-use zone is YELLOW**, not RED, with `cup_required = LIKELY`.
   Under the seeded table that makes every residential zone YELLOW and the
   business/mixed-use zones GREEN-capable, which is the realistic Lexington
   picture until LFUCG confirms the ordinance text.

**One correction the defaults forced.** Phase 1's `fn_density_test` returned
`DATA_REQUIRED` both when no density rule was configured *and* when a configured
rule had no dwelling-unit denominator. With decision 3 that would have made every
property in the market permanently YELLOW over a rule nobody has established
exists — the caveat would have become noise and stopped meaning anything. The
test now returns `NOT_CONFIGURED` for the first case, which the classifier
ignores, and keeps `DATA_REQUIRED` for the second, which still forces YELLOW.
No percentage is invented in either case; the original promise is intact.

**Still open, and blocking nothing:** the seeded zoning treatments and the 600-ft
citation are both marked "(verify)". The engine is only as good as that table —
confirm it with LFUCG Planning before anyone acts on a GREEN.

### Phase 4 — Listings Engine ✅ (delivered)
- `ListingsProvider` interface; `CsvProvider`, `JsonProvider`, stub `ResoWebApiProvider`
- **🔄 Refresh Lexington Listings**: diff engine (new / price change / removed), `listing_price_history`, `listing_refreshes` audit, re-run eligibility + scoring on changed rows only
- All Listings page with the optional filter set (§15)

**What shipped**

| Piece | Where |
|---|---|
| Property identity + merge of existing duplicates + `fn_match_property` | migration `0005_phase4.sql` |
| `v_listings_enriched` (listing + property + latest eligibility) | `0005_phase4.sql` |
| `fn_listing_summary`, `fn_stale_eligibility` | `0005_phase4.sql` |
| Diff engine — new / price change / status change / relisted / removed / unchanged | `src/lib/listings/diff.ts` |
| Optional filter set: parse, validate, apply, describe | `src/lib/listings/query.ts` |
| The refresh engine both entry points share | `src/lib/listings/refresh.ts` |
| 🔄 Refresh action with a full-sync opt-in | Admin → *2 · Refresh Lexington listings* |
| All Listings page — 12 filters, 9 sorts, paging | `src/app/(app)/listings/page.tsx` |

**Interpretation of §15.** The original spec section was not available when this
was built, so the optional filter set was chosen to cover what an acquisition
screen actually needs: price range, beds, baths, sqft, lot size, year built,
property type, ZIP, HOA status, eligibility classification, zoning code, pool /
garage / basement, days on market, price-reduced-only, screened-only, and free
text over the address. Adding to it is a one-line change in
`lib/listings/query.ts` plus a control on the page — say the word if the real
§15 list differs.

**Three Phase 1 defects fixed here, because Phase 4 sits directly on them**

1. **Every new listing inserted a fresh `properties` row.** There was no lookup
   and no constraint, so the same house arriving from a second provider, or
   re-listed under a new MLS number, became a second property — splitting its
   notes, pipeline status and eligibility history, and double-counting it in any
   ranking. Properties now have an identity (`market_id`, `address_norm`,
   `coalesce(unit,'')`) enforced by a unique index; `fn_match_property` resolves
   by canonical address and then by coordinates within 60 ft before anything is
   created. Migration 0005 merges any duplicates that already exist, re-pointing
   listings, notes, pipeline rows and saved properties onto the earliest row.
2. **Full-sync removal defaulted ON** (`body.full !== false`), so pasting a
   five-row correction marked every other listing in the market as removed. It
   is now opt-in at both entry points, the UI states what the checkbox does, and
   a partial refresh reports "removals not evaluated" rather than silently
   skipping them.
3. **`bool()` returned false for anything it did not recognize**, so a CSV
   carrying "unknown" or "N/A" in the HOA column produced `VERIFIED_NO_HOA` —
   asserting a verification nobody performed and pushing the property into the
   qualified pool. It is tri-state now, and `normalizeRow` routes through
   `hoaStatusFrom`, which only returns VERIFIED_NO_HOA when an explicit
   `hoa_verified` column vouches for it.

**One engine, two doors.** `/api/listings/import` is kept for existing callers
and cron entries but delegates to `runRefresh` — there is no second import path
that can drift from the first.

**Re-screening is scoped.** A price move does not change the 600-ft answer, so
only `new` and `relisted` rows trigger an eligibility check. A full market
re-screen stays available in Admin → *1b*.

### Phase 5 — Sixgen Revenue Intelligence ✅ (delivered)
- Sixgen import wizard (CSV/XLSX) + **Guesty connector import** (already authenticated)
- `sixgen_properties`, `sixgen_monthly_performance`, `sixgen_annual_performance` (append-only)
- Comparable engine v1: similarity on bedrooms, capacity, then ADR/occ/revenue; weighted comps → ADR, occupancy (capped by rule), revenue; conservative/base/upside from comp dispersion; monthly curve when monthly data exists; confidence from comp coverage
- `revenue_forecasts` + `comparable_matches` with model version

**What shipped**

| Piece | Where |
|---|---|
| Append-only history made real; `v_sixgen_monthly_current` | migration `0006_phase5.sql` |
| `fn_sixgen_t12`, `fn_sixgen_seasonality`, `fn_sixgen_portfolio_summary` | `0006_phase5.sql` |
| `v_property_forecast` (latest per property/scenario) | `0006_phase5.sql` |
| Comparable engine: similarity, weighting, dispersion, confidence | `src/lib/comps/engine.ts` |
| Guesty portfolio + monthly normalization with honest warnings | `src/lib/import/sixgen.ts` |
| Portfolio import; batch and ad-hoc forecasting | `src/app/api/sixgen/import`, `src/app/api/forecasts` |
| Sixgen Comps page — model a hypothetical, see the comps behind it | `src/app/(app)/comps/page.tsx` |
| Import + *Run forecasts* actions | Admin → *3 · Sixgen performance + forecasts* |

**The model is deliberately small.** Sixgen has seventeen listings. That is not
enough to justify a fitted model, and a regression on seventeen points would look
authoritative while being noise. So: score similarity on the attributes that
actually move nightly rate (bedrooms at 50%, sleeps 20%, baths 10%, amenities
20%), weight the closest six, take the weighted mean for the base case and the
weighted p25/p75 for the range, and report plainly how thin the basis is.

**Three properties of the source data drove the design** (see `data/sixgen/README.md`):

1. **Occupancy is a floor.** `available_nights` is calendar days; owner and
   maintenance blocks are unknown. Every forecast carries that caveat rather
   than presenting the figure as a true occupancy rate.
2. **Pre-launch zeros are not vacancy.** 720 W Short St went live in June 2025
   and has nine zero months before it. Comps are therefore built on trailing
   twelve months, and each comp's influence is scaled by `months_with_data` — a
   three-month listing is real evidence, just less of it, and its zeros never
   enter the average.
3. **Revenue is attributed to the check-in month**, so one 22-night stay can
   dominate a month. The basis is annual; the monthly curve is a shape applied
   to that annual figure, never twelve independent predictions.

**A Phase 1 defect fixed here.** `buildScenarios` added 0.07 to an
already-normalized occupancy and passed the result back through
`normalizeOccupancy`, which read anything above 1 as a percentage. A base
occupancy of 0.95 produced an "upside" of 1.02 → 0.0102, so the upside scenario
came out roughly a hundredth of the conservative one. `shiftOccupancy` now clamps
to [0, 1] instead of re-normalizing, and a regression test pins the ordering.

**Not built, and why:** the plan lists a Guesty *connector* import alongside the
file import. The file path is done and tested against the real export; a live
API adapter belongs behind `GUESTY_API_KEY` in the same shape as
`ListingsProvider`, and is worth doing once someone wants scheduled refreshes
rather than a quarterly pull.

### Phase 6 — Top 25 & Underwriting ✅ (delivered)
- Acquisition score (eligibility is a **gate**, then weighted factors from `scoring_weights`)
- Top 25 page (all columns in §24, sortable) + "Needs HOA Verification" and "Requires Review" side lists
- Property detail page: header, eligibility card, map, comps, editable pro forma (NOI, cap rate, optional financing → CoC), amenity upside scenarios
- Pipeline (statuses §33), saved properties, notes, saved searches

**What shipped**

| Piece | Where |
|---|---|
| `v_acquisition_candidates` — listing + property + eligibility + forecast in one row | migration `0007_phase6.sql` |
| `fn_scoring_weights`, `fn_sixgen_demand_points`, `fn_acquisition_summary` | `0007_phase6.sql` |
| `v_top_candidates` (gated rows excluded), `fn_property_detail` | `0007_phase6.sql` |
| Gate + eight weighted factors, weight redistribution, breakdown | `src/lib/scoring/score.ts` |
| NOI · cap rate · DSCR · cash-on-cash · break-even occupancy · amenity upside | `src/lib/proforma.ts` |
| Ranking, property detail + actions, pipeline board | `src/app/api/{scores,properties/[id],pipeline}` |
| Top 25 with an inline “why” breakdown, property page, pipeline board | `src/app/(app)/{top25,property/[id],pipeline}` |

**Eligibility is a gate, not a factor.** A RED property is recorded with its gate
reason and no score. Scoring it 40/100 and letting it sit mid-table would be
worse than useless: the number invites someone to trade "fails the separation
rule" off against "high yield". YELLOW and an unverified HOA do *not* gate —
those are unknowns rather than failures, and each gets its own side list.

**Factors are normalized across the candidate pool**, not against absolute
thresholds. A 9% gross yield is only good relative to what else is on the market
this week, and a fixed threshold would silently rot as the market moved.

**A missing input redistributes its weight.** A property with no square footage
cannot be scored on price efficiency; counting that as zero would rank it below a
genuinely expensive house. The remaining weights are rescaled to sum to 1 and the
breakdown records which factors were unavailable and why — shown on the Top 25
row when you press *why*.

**Interpretation of §24 and §33.** Neither section was available, so the column
set and the pipeline statuses were chosen to match the workflow the rest of the
app implies: New · Researching · Contacted · Offer Prepared · Offer Submitted ·
Under Contract · Closed · Passed. Both are stored in `app_settings`, so changing
them is a data edit rather than a deploy.

**On `location_demand`.** There is no third-party demand feed wired in. Rather
than invent one or leave the factor permanently dark, it scores proximity to
Sixgen's own producing listings, weighted by their trailing-twelve revenue —
seventeen locations the business has already proven. Where no portfolio geography
is loaded the factor reports unavailable and its weight redistributes.

**On the pro forma.** Every line is an editable input with its basis shown; the
expense block is where short-term-rental operating intensity becomes visible, and
the result deliberately stops short of depreciation, amortization and tax
treatment. Those belong to an accountant, and numbers produced here would be a
liability if used for them. Amenity lift percentages are planning figures: the
portfolio shows amenity-rich listings out-earning bare ones, but seventeen
listings cannot separate the amenity from the house it sits in. They should be
revised against real before/after data — which the portfolio will supply once an
upgrade is made and tracked.

**Deferred:** saved searches. The table and the filter shape both exist (Phase 4
parses and serializes the whole optional filter set), so this is a small piece of
UI rather than new machinery — it was left out to keep this phase's surface
honest rather than half-wired.

### Phase 7 — Production Launch ✅ (delivered)
- QA pass, error boundaries, mobile layout, rate limiting on public routes, backups (Supabase PITR), structured logging, Netlify deploy, operator docs
- Optional: MapLibre vector parcels; scheduled refresh; alert architecture

**What shipped**

| Piece | Where |
|---|---|
| Error boundaries at every level, plus not-found and loading | `src/app/{error,global-error,not-found}.tsx`, `(app)/{error,loading}.tsx` |
| Structured JSON logging with credential redaction | `src/lib/log.ts` |
| Fixed-window rate limiting on every session-free route | `src/lib/rateLimit.ts` |
| Security headers, in middleware and at the edge | `src/middleware.ts`, `netlify.toml` |
| Mobile drawer navigation | `src/components/AppShell.tsx` |
| Health check that probes the database and data freshness | `src/app/api/health/route.ts` |
| Operator runbook | `docs/RUNBOOK.md` |

**The QA pass found three real defects.** All three were invisible to the test
suite and to the build, and only surfaced by running the app and reading the
responses:

1. **The middleware had never executed — in any phase.** This project uses a
   `src` directory, and Next loads middleware only from `src/middleware.ts` in
   that layout; the file sat at the repository root and was silently ignored.
   The auth gate happened to be enforced independently by `(app)/layout.tsx`, so
   nothing was exposed, and every API route validates its own session (the
   Phase 7 `api-auth` invariant proves that) — but Phase 7's rate limiting and
   security headers would have shipped dead. Moving the file made `Middleware
   86.9 kB` appear in the build output for the first time. A regression test now
   asserts the location.
2. **Enabling the middleware then broke the API error contract.** Unauthenticated
   `/api/*` calls began 307-redirecting to `/login`, so `fetch()` followed the
   redirect and received HTML — every client-side error path in the app would
   have failed trying to parse it. API paths now return `401` JSON.
3. **Log redaction missed the secrets that actually matter.** The key pattern was
   anchored, so `authorization` was caught but `SUPABASE_SERVICE_ROLE_KEY` and
   `IMPORT_SECRET` were not. It is a substring match now, deliberately excluding
   a bare `*_key` suffix so `rule_key` and `factor_key` still log.

**A deployment constraint worth stating plainly.** Netlify caps synchronous
functions at 26 seconds. The permit import geocodes about a thousand addresses
and the GIS sync rebuilds the dissolved exclusion in PostGIS; both exceed that.
`vercel.json` now declares 300 s for all ten heavy routes (it covered two), a
test fails if a route declares a long `maxDuration` without a matching host
entry, and `docs/RUNBOOK.md` documents the bearer-token path for running those
operations from a machine instead. The interactive pages are all well inside the
ceiling.

**Not done, and deliberately so:** MapLibre vector parcels, scheduled refresh and
the alert architecture were listed as optional. Leaflet is adequate at the
current parcel volume, and scheduled refresh is better configured as a host cron
hitting the existing bearer-token endpoints than as new machinery inside the app
— the runbook gives the exact commands.

**Every phase ends with:** tests run → demo of what works → list of missing inputs → fixes → nothing from prior phases regressed.

---

## 4. Database design (v2, PostGIS)

Core reference: `markets`, `jurisdictions`, `str_rules` (versioned), `scoring_weights`, `app_settings`
Identity: `profiles`, `allowed_emails`
Government GIS cache: `parcels` (geom 4326 + generated 2246, PVA id, acreage, zoning FK), `zoning_districts`
STR supply: `str_permits` (geom, parcel FK, blocking flag, match confidence), `market_exclusions`
Listings: `properties` (the physical place, parcel-linked), `listings` (a for-sale event), `listing_price_history`, `property_features`, `hoa_verifications`
Sixgen: `sixgen_properties`, `sixgen_monthly_performance`, `sixgen_annual_performance`
Analysis: `eligibility_checks`, `eligibility_failures`, `revenue_forecasts`, `comparable_matches`, `acquisition_scores`, `pro_formas`
Workflow: `saved_properties`, `saved_searches`, `acquisition_pipeline`, `property_notes`
Ops: `imports`, `import_rows`, `listing_refreshes`, `audit_logs`, `data_errors`

Full DDL: `supabase/migrations/0001_foundation.sql`. Spatial functions: `supabase/migrations/0002_functions.sql`.

---

## 5. External credentials — what's needed when

| Credential | Needed in | Status |
|---|---|---|
| Supabase URL / anon / service-role | Phase 1 | You create the project (free) |
| `IMPORT_SECRET` (any long string) | Phase 1 | You choose it |
| LFUCG ArcGIS | Phase 1 | **Public, no key** |
| Geocoder | Phase 2 | LFUCG Address_Point (public) primary; Census (public) fallback. No key. |
| Listings provider | Phase 4 | **CSV/JSON works with none.** For live data: RESO Web API creds from your MLS (Imagine MLS / Bluegrass REALTORS®) or a licensed vendor (Bridge Interactive, Zillow Bridge partner access). |
| Guesty | Phase 5 | Already connected via MCP; API key optional for in-app sync |
| Mapbox token | Never required | Only if you later choose Mapbox over Leaflet/MapLibre |
| Netlify | Phase 7 | Free account |

---

## 6. Non-negotiable product invariants

1. **Every permitted STR is always on the map.** All 734 permits (622 un-hosted, 112 hosted) render regardless of size, value, type, or status. Only the *blocking* flag changes styling and whether a permit counts toward the separation rule. Guarded by `tests/permits.test.ts` (three tests: pass-through mapper, no filter imports near permit code, no predicates on the market permit query) — the build fails if violated.
2. **Bedroom / price / HOA filters apply only to for-sale listings** (`src/lib/filters.ts`). They are never applied to permits or to Sixgen historical properties.
3. **Missing data is never treated as fact** (HOA_UNKNOWN, DATA_REQUIRED, REQUIRES REVIEW).

## 7. Sixgen historical data — already in the repo

`data/sixgen/` contains the full Lexington portfolio pulled from Guesty on Sep 3, 2026:
- `sixgen_properties.csv` — all **17** Lexington homes (beds, baths, sleeps, lat/lng, amenity flags from tags/title)
- `sixgen_monthly_performance.csv` — **24 months × 17 = 408 rows** (Sep 2024–Aug 2026), 2,417 reservations, host-payout basis, every listing reconciled to the API count
- `README.md` — provenance, definitions, and anomalies (check-in-month attribution, mid-term stays at 617 Stratford, 720 W Short live since Jun 2025, a handful of $0 comp entries)

Trailing-12 portfolio: **$2,335,364 · 71.0% occupancy · $530 ADR**. Phase 5's import wizard loads these files directly; the Guesty connector can refresh them later.

## 8. Handoff to Claude Code

This repo is self-describing. In Claude Code, open the folder and say:
> "Read docs/IMPLEMENTATION_PLAN.md and README.md. Run `npm install && npm test && npm run build` to confirm Phase 1 is green. Then start Phase 2 (permit import wizard) — the ORR-2026-1259 file has a 5-column composite address; see §3 Phase 2."

Connectors used here (Guesty, Wheelhouse) can be added to Claude Code as MCP servers, but nothing in Phases 2–6 requires them: the data they would have supplied is already exported in `data/sixgen/`.

## 9. Open items I need from you (not blocking Phase 1)

1. **Sixgen historical performance file** (or permission to pull all 17 properties from Guesty in Phase 5 — I already have 7).
2. **Confirm the current 1,000-ft density threshold** in the LFUCG ordinance so I can enable that rule. Until confirmed it stays disabled and the UI shows *Density Check: DATA REQUIRED*.
3. **Listing source decision for Phase 4** — CSV export from your agent's MLS is the fastest compliant path; a RESO feed is the long-term one.
