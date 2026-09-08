import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ringsToMultiPolygon, parcelAttrs } from "../src/lib/gis/parcel";

/**
 * Two kinds of guard live here.
 *
 * 1. Real assertions on `ringsToMultiPolygon`, which converts LFUCG parcel
 *    geometry into what PostGIS buffers. A mistake here is invisible on screen
 *    and wrong in the legal screen.
 * 2. Source-level guards on the migrations. The PostGIS functions themselves can
 *    only be executed against a database (supabase/tests/spatial.sql does that),
 *    so these assert that the specific defects fixed in 0003 have not returned.
 */

const sql = (f: string) => readFileSync(join(__dirname, "..", "supabase", "migrations", f), "utf8");

// ── geometry conversion ─────────────────────────────────────────────────────
// ArcGIS: exterior rings are clockwise, holes counter-clockwise, all flattened
// into one array. Squares below are written explicitly in each winding.
const cw = (x: number, y: number, s = 1) => [[x, y], [x, y + s], [x + s, y + s], [x + s, y], [x, y]];
const ccw = (x: number, y: number, s = 1) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]];

test("a single-part parcel becomes one polygon", () => {
  const g = ringsToMultiPolygon([cw(0, 0, 10)]);
  assert.equal(g.type, "MultiPolygon");
  assert.equal(g.coordinates.length, 1);
  assert.equal(g.coordinates[0].length, 1, "no phantom hole");
});

test("a parcel with a hole becomes one polygon with an interior ring", () => {
  const g = ringsToMultiPolygon([cw(0, 0, 10), ccw(2, 2, 3)]);
  assert.equal(g.coordinates.length, 1);
  assert.equal(g.coordinates[0].length, 2, "exterior + one hole");
});

test("a two-part parcel becomes two polygons, not one with a hole punched out", () => {
  // the Phase 1 conversion produced [[partA, partB]] — partB read as a hole
  const g = ringsToMultiPolygon([cw(0, 0, 10), cw(50, 50, 10)]);
  assert.equal(g.coordinates.length, 2, "two separate parts");
  assert.equal(g.coordinates[0].length, 1);
  assert.equal(g.coordinates[1].length, 1);
});

test("two parts where the second has its own hole keep the hole with the right part", () => {
  const g = ringsToMultiPolygon([cw(0, 0, 10), cw(50, 50, 10), ccw(52, 52, 3)]);
  assert.equal(g.coordinates.length, 2);
  assert.equal(g.coordinates[0].length, 1);
  assert.equal(g.coordinates[1].length, 2);
});

test("exterior rings are emitted counter-clockwise per RFC 7946", () => {
  const area = (r: number[][]) => r.reduce((a, _, i) => {
    const [x1, y1] = r[i], [x2, y2] = r[(i + 1) % r.length];
    return a + (x1 * y2 - x2 * y1);
  }, 0) / 2;
  const g = ringsToMultiPolygon([cw(0, 0, 10)]);
  assert.ok(area(g.coordinates[0][0]) > 0, "GeoJSON exterior rings wind counter-clockwise");
});

test("degenerate and empty input produce empty geometry rather than throwing", () => {
  assert.deepEqual(ringsToMultiPolygon([]).coordinates, []);
  assert.deepEqual(ringsToMultiPolygon([[[0, 0], [1, 1]]]).coordinates, [], "a 2-point ring is not a polygon");
  assert.deepEqual(ringsToMultiPolygon(undefined as any).coordinates, []);
});

// ── parcel attribute mapping ────────────────────────────────────────────────
test("LFUCG's real field names are read, not the guessed ones", () => {
  // Verified against the live layer: the fields are PVANUM and PVA_ACRE.
  // The old code looked for PVA_NUM / PARCEL_ID / PIN / ACREAGE / Acres, none of
  // which exist there, so every cached parcel stored null for both.
  const real = {
    PVANUM: "24631400", ADDRESS: "697 CINDY BLAIR WAY", PVA_ACRE: 0.5206,
    Shape__Area: 23674.815979003906, OBJECTID: 53397911,
  };
  const { pvaId, acreage } = parcelAttrs(real);
  assert.equal(pvaId, "24631400");
  assert.equal(acreage, 0.5206);
});

test("other jurisdictions' spellings still resolve", () => {
  assert.equal(parcelAttrs({ PARCEL_ID: "X-1", ACREAGE: 2.5 }).pvaId, "X-1");
  assert.equal(parcelAttrs({ PARCEL_ID: "X-1", ACREAGE: 2.5 }).acreage, 2.5);
  assert.equal(parcelAttrs({ PIN: 99, Acres: "1.25" }).pvaId, "99", "a numeric id becomes a string");
  assert.equal(parcelAttrs({ PIN: 99, Acres: "1.25" }).acreage, 1.25);
});

test("geometry area is the last resort, converted from square feet", () => {
  // SRID 2246 is US survey feet, so Shape__Area / 43560 is acres
  const { acreage } = parcelAttrs({ Shape__Area: 43560 });
  assert.equal(acreage, 1);
  assert.equal(parcelAttrs({ PVA_ACRE: 0.5206, Shape__Area: 43560 }).acreage, 0.5206,
    "the assessor's figure wins over the geometry");
});

test("missing or unusable attributes yield null rather than zero or NaN", () => {
  assert.deepEqual(parcelAttrs({}), { pvaId: null, acreage: null });
  assert.deepEqual(parcelAttrs(null), { pvaId: null, acreage: null });
  assert.equal(parcelAttrs({ PVA_ACRE: 0 }).acreage, null, "a zero-acre parcel is not a real measurement");
  assert.equal(parcelAttrs({ PVA_ACRE: "not a number" }).acreage, null);
  assert.equal(parcelAttrs({ PVANUM: "" }).pvaId, null);
});

test("REGRESSION: the attribute mapping is defined once, not copied per call site", () => {
  // It was duplicated across resolveParcel and two import routes, which is how
  // the wrong field names survived unnoticed.
  const files = ["src/app/api/refresh/route.ts", "src/app/api/imports/permits/commit/route.ts"];
  for (const f of files) {
    const src = readFileSync(join(__dirname, "..", f), "utf8");
    assert.ok(/parcelAttrs/.test(src), `${f} must use the shared helper`);
    assert.ok(!/PVA_NUM\s*\?\?|attrs\?\.ACREAGE/.test(src), `${f} still has an inline attribute mapping`);
  }
});

// ── migration guards ────────────────────────────────────────────────────────
test("REGRESSION: the exclusion rebuild does not dedupe across parcel and permit id spaces", () => {
  const s = sql("0003_phase2.sql");
  assert.ok(!/distinct on \(coalesce\(pc\.id, sp\.id\)\)/.test(s),
    "parcels.id and str_permits.id are independent sequences; a shared dedupe key drops real 600-ft buffers");
  assert.ok(/distinct on \(case when pc\.id is not null then 'p'/.test(s), "keys must be namespaced");
});

test("REGRESSION: the spacing test considers every blocking permit inside the radius", () => {
  const s = sql("0003_phase2.sql");
  const fn = s.slice(s.indexOf("function fn_spacing_test"), s.indexOf("function fn_link_permits_to_parcels"));
  assert.ok(/ST_DWithin/.test(fn), "it must filter to permits inside the spacing radius…");
  assert.ok(/order by \(pc\.geom is not null\) desc/.test(fn),
    "…and rank parcel-measured violations above point-measured ones, so a definite FAIL is never reported as REVIEW");
});

test("REGRESSION: parcel linking never overwrites a manual correction", () => {
  const s = sql("0003_phase2.sql");
  const fn = s.slice(s.indexOf("function fn_link_permits_to_parcels"), s.indexOf("function fn_rebuild_exclusions"));
  assert.ok(/match_method is distinct from 'manual'/.test(fn));
});

test("REGRESSION: an unknown permit status or type blocks rather than clears", () => {
  const s = sql("0003_phase2.sql");
  assert.ok(/array\['active','unknown'\]/.test(s), "the default blocking set includes 'unknown'");
  assert.ok(/type unknown . blocking by default/.test(s));
});

test("REGRESSION: str_rules and zoning_districts have unique keys, so re-seeding cannot duplicate them", () => {
  const s = sql("0003_phase2.sql");
  assert.ok(/create unique index if not exists str_rules_uniq/.test(s));
  assert.ok(/create unique index if not exists zoning_districts_uniq/.test(s));
});
