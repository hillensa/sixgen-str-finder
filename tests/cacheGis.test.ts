import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { distinctPoints } from "../src/lib/listings/geolocate";
import { upsertZoningDistricts } from "../src/lib/gis/zoning";

const src = (f: string) => readFileSync(join(__dirname, "..", f), "utf8");

// ── point deduplication ────────────────────────────────────────────────────
test("identical points cost one request, not one per listing", () => {
  const pts = distinctPoints([
    { lng: -84.5, lat: 38.0 }, { lng: -84.5, lat: 38.0 },   // two units, one building
    { lng: -84.6, lat: 38.1 },
  ]);
  assert.equal(pts.length, 2);
});

test("unusable coordinates never reach the projection", () => {
  // proj4 turns NaN into NaN and ArcGIS would reject the whole batch, taking the
  // valid points down with it
  const pts = distinctPoints([
    { lng: NaN, lat: 38.0 }, { lng: -84.5, lat: Infinity },
    { lng: undefined as any, lat: 38.0 }, { lng: -84.5, lat: 38.0 },
  ]);
  assert.deepEqual(pts, [{ lng: -84.5, lat: 38.0 }]);
});

test("points that differ below a centimetre are still one point", () => {
  const pts = distinctPoints([{ lng: -84.51234567, lat: 38.0 }, { lng: -84.512345674, lat: 38.0 }]);
  assert.equal(pts.length, 1, "a parcel boundary is never that fine");
});

// ── the partial-index trap ─────────────────────────────────────────────────
// The rule itself — that no upsert may name a key ON CONFLICT cannot use — is
// enforced across the whole schema in uniqueKeys.test.ts. What remains here is
// the behaviour of the replacement write path.

test("a duplicate-key race is not treated as a failure", async () => {
  // Two concurrent imports can reach the same district. The index rejecting the
  // second insert is the correct outcome, not something to report.
  const db = {
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
      insert: async () => ({ error: { message: 'duplicate key value violates unique constraint "zoning_districts_uniq"' } }),
    }),
  };
  const r = await upsertZoningDistricts(db as any, [{
    jurisdiction_id: "lfucg", source_object_id: 1, zone_code: "R-1B",
    ordinance_url: null, geom: {}, fetched_at: "2026-09-07T00:00:00Z",
  }]);
  assert.equal(r.error, undefined);
  assert.equal(r.written, 1);
});

test("a real write failure is reported rather than swallowed", async () => {
  const db = {
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
      insert: async () => ({ error: { message: "permission denied for table zoning_districts" } }),
    }),
  };
  const r = await upsertZoningDistricts(db as any, [{
    jurisdiction_id: "lfucg", source_object_id: 1, zone_code: "R-1B",
    ordinance_url: null, geom: {}, fetched_at: "2026-09-07T00:00:00Z",
  }]);
  assert.match(r.error ?? "", /permission denied/);
});

// ── ordering ───────────────────────────────────────────────────────────────
test("REGRESSION: the GIS cache is filled before properties are linked to parcels", () => {
  // fn_link_properties_to_parcels and fn_eligibility_facts read cached geometry
  // only. Filling the cache afterwards would leave every listing in this run
  // PARCEL_NOT_MATCHED and defer the benefit to the next refresh.
  const s = src("src/lib/listings/refresh.ts");
  const cache = s.indexOf("cacheGisForPoints(db");
  const link = s.indexOf('rpc("fn_link_properties_to_parcels"');
  assert.ok(cache > 0, "the refresh must populate the parcel/zoning cache");
  assert.ok(link > 0);
  assert.ok(cache < link, "cache the geometry before linking against it");
});
