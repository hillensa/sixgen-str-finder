# Sixgen STR Finder — Operator Runbook

Everything needed to stand this up, keep it fed, and know when not to trust it.

---

## 1. First-time setup

1. **Supabase project** → SQL Editor → run in order:
   `0001_foundation` · `0002_functions` · `0003_phase2` · `0004_phase3` ·
   `0005_phase4` · `0006_phase5` · `0007_phase6` · then `seed.sql`.
   Run `0003` before ever re-running `seed.sql`; it adds the unique keys the
   seed's `on conflict` clauses assume, and without them a re-seed duplicates
   every rule.
2. **Authentication → URL Configuration** — add the site URL and
   `<site>/auth/callback`.
3. **Environment** — copy `.env.example` to `.env.local` (or set on the host):

   | Variable | Purpose |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | project URL |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | browser client, RLS-scoped |
   | `SUPABASE_SERVICE_ROLE_KEY` | **server only** — bypasses RLS by design |
   | `NEXT_PUBLIC_SITE_URL` | used in invite emails |
   | `IMPORT_SECRET` | bearer token for machine-run imports |
   | `LOG_LEVEL` | `debug` \| `info` (default) \| `warn` \| `error` |

   The service-role key must never reach the browser. It is read only inside
   route handlers, and `src/lib/log.ts` redacts anything shaped like a key
   before it can reach a log line.
4. **First admin** — `seed.sql` invites `seth@sixgenrentals.com`. The first
   account to sign in becomes admin; everyone after that is invited from
   Admin → *Who can log in*.

---

## 2. Loading the market (in order)

| # | Action | Where | Runtime |
|---|---|---|---|
| 1 | Sync city data | Admin → *1 · City GIS sync* | ~30 s |
| 2 | Import the ORR permit spreadsheet | Data → *Import STR permits* | 1–3 min |
| 3 | Work the match report | `/data/permits/<id>` | manual |
| 4 | Rebuild the exclusion | match report → *Rebuild exclusion* | ~10 s |
| 5 | Import the Sixgen portfolio | Admin → *3 · Sixgen performance* | ~10 s |
| 6 | Refresh listings | Admin → *2 · Refresh listings* | ~30 s |
| 7 | Run forecasts | Admin → *3 · Run forecasts* | ~20 s |
| 8 | Re-rank | Top 25 → *Re-rank* | ~5 s |

Steps 6–8 are the weekly loop. Steps 1–4 are quarterly, or whenever LFUCG
publishes a new permit file.

**The order matters.** Forecasts need the Sixgen portfolio; scores need
forecasts and eligibility. Running them out of order is safe — each refuses with
an explanation rather than producing an empty answer.

---

## 3. Long-running operations

The permit import geocodes about a thousand addresses and the GIS sync rebuilds
the dissolved exclusion in PostGIS. Both exceed **Netlify's 26-second function
ceiling**.

Options, in order of preference:

1. **Deploy on a host with a longer function duration.** `vercel.json` already
   declares 300 s for every heavy route.
2. **Run them from a machine** with the bearer token — no browser, no timeout:

   ```bash
   curl -X POST "$SITE/api/refresh?jurisdiction=lfucg" \
     -H "Authorization: Bearer $IMPORT_SECRET"

   curl -X POST "$SITE/api/listings/refresh" \
     -H "Authorization: Bearer $IMPORT_SECRET" \
     -H "content-type: application/json" \
     -d '{"market":"lexington-ky","format":"csv","input":"...","fullSync":true}'

   curl -X POST "$SITE/api/forecasts?market=lexington-ky" -H "Authorization: Bearer $IMPORT_SECRET"
   curl -X POST "$SITE/api/scores?market=lexington-ky"    -H "Authorization: Bearer $IMPORT_SECRET"
   ```
3. **Split the work.** The permit import accepts one worksheet at a time; the
   geocode cache means a re-run after a timeout is much faster than the first.

Everything the interactive pages do is well inside 26 s.

---

## 4. Monitoring

`GET /api/health` is the only route reachable without a session.

```json
{ "ok": true, "status": "healthy", "checks": { "config": {...}, "database": {...},
  "exclusion_freshness": {...} }, "dataAgeHours": 6 }
```

- `200` + `healthy` — serving, data fresh.
- `200` + `degraded` — serving, but something is stale. Most often the exclusion
  zone is over two weeks old, which means the 600-ft screen is being run against
  old permit data.
- `503` + `down` — missing configuration or the database is unreachable. **No
  screening result should be trusted.**

Point an uptime monitor at it and alert on anything that is not `200`.

Logs are one JSON object per line. Useful events: `ratelimit.blocked`,
`auth.unavailable`, `health.database`, `client.boundary`.

---

## 5. Backups and recovery

Supabase Point-in-Time Recovery must be enabled **in the Supabase dashboard** —
it is a project setting, not something this repo can configure. Database →
Backups → enable PITR (paid plans; 7-day window is enough here).

What actually needs protecting, and why:

| Data | Recoverable without a backup? |
|---|---|
| `str_permits`, `parcels`, `zoning_districts` | Yes — re-run the GIS sync and the permit import. |
| `geocode_cache` | Yes, but slowly; it will re-fill on the next import. |
| `listings`, `properties` | Only back to the last provider file you still hold. |
| `sixgen_*` | Yes, from `data/sixgen/` and Guesty. |
| **`str_rules`** | **No.** Hand-entered legal configuration. |
| **`eligibility_checks` / `eligibility_failures`** | **No.** These are the audit trail of what was screened, when, and under which rules version. |
| **`property_notes`, `acquisition_pipeline`, `pro_formas`** | **No.** Human work product. |

Before any migration or bulk edit, export the four bold rows.

---

## 6. When results should not be trusted

The app is built to say so itself, but these are the conditions worth knowing:

- **`/api/health` reports `degraded` on exclusion freshness.** The separation
  test is running against stale permits.
- **A permit sits in `possible` or `unmatched`.** Its distance was measured from
  a geocoded point, not a parcel line. The screen reports `REVIEW`, not `PASS`.
- **`density_result` is `DATA_REQUIRED`.** A density rule is enabled but there is
  no dwelling-unit denominator. (`NOT_CONFIGURED` is different and fine — it
  means no density rule has been established.)
- **A forecast shows `LOW` confidence.** Fewer than two close comps, or thin
  trading history behind them.
- **Any GREEN.** GREEN means every check this tool can make passed. It is not a
  legal opinion, and LFUCG Planning confirmation is still required.

---

## 7. Routine maintenance

| Cadence | Task |
|---|---|
| Weekly | Refresh listings → run forecasts → re-rank. |
| Monthly | Review `data_errors` and the permit match report for unresolved rows. |
| Quarterly | Re-import the ORR permit file; re-import the Sixgen portfolio. |
| On any rules change | Admin → *Re-run eligibility*, then Top 25 → *Re-rank*. Old rows keep the `rules_version` they were decided under, so stale results stay visible rather than being silently reinterpreted. |
| Before acting on a GREEN | Confirm zoning treatment and the separation rule with LFUCG Planning. |

### Open items carried forward

- The seeded zoning treatments and the 600-ft citation are both marked
  `(verify)` in `str_rules`. The eligibility engine is only as good as that
  table.
- The 1,000-ft density rule ships **disabled** pending confirmation of the
  ordinance text and a dwelling-unit source.
- Amenity lift percentages in the pro forma are planning figures, not measured
  ones. Revise them once an upgrade has been made and tracked.
- Saved searches are not built; the table and the filter serialization exist.
- The Guesty *connector* import is not built; the file import is.
