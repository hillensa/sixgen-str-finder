import { test } from "node:test";
import assert from "node:assert/strict";
/**
 * GIS boundary tests (spec §43). Exercises the same geodesic math the PostGIS
 * functions perform: 599 ft must FAIL, 601 ft must PASS. The PostGIS versions
 * themselves are exercised by supabase/tests/spatial.sql.
 */
const spacingTest = (distanceFt: number, ruleFt = 600) => (distanceFt >= ruleFt ? "PASS" : "FAIL");

async function turf() {
  try {
    const [d, dest, h] = await Promise.all([import("@turf/distance"), import("@turf/destination"), import("@turf/helpers")]);
    return { distance: (d as any).default ?? d, destination: (dest as any).default ?? dest, point: (h as any).point };
  } catch { return null; }
}

test("spacing rule boundary: 599 FAIL, 600 PASS, 601 PASS", () => {
  assert.equal(spacingTest(599), "FAIL"); assert.equal(spacingTest(600), "PASS"); assert.equal(spacingTest(601), "PASS");
});

test("geodesic distance at Lexington latitude is accurate to <0.1 ft over 600 ft", async (t) => {
  const T = await turf(); if (!T) return t.skip("turf not installed");
  const a = T.point([-84.5, 38.035]);
  const d = T.distance(a, T.destination(a, 600, 90, { units: "feet" }), { units: "feet" });
  assert.ok(Math.abs(d - 600) < 0.1, `got ${d}`);
});

test("599 ft and 601 ft points classify correctly with geodesic math", async (t) => {
  const T = await turf(); if (!T) return t.skip("turf not installed");
  const a = T.point([-84.5, 38.035]);
  const d599 = T.distance(a, T.destination(a, 599, 45, { units: "feet" }), { units: "feet" });
  const d601 = T.distance(a, T.destination(a, 601, 45, { units: "feet" }), { units: "feet" });
  assert.equal(spacingTest(d599), "FAIL"); assert.equal(spacingTest(d601), "PASS");
});

test("density: DATA_REQUIRED when denominator missing; correct math when present", () => {
  const density = (strs: number, units: number | null, thresh: number) =>
    units == null || units === 0 ? { result: "DATA_REQUIRED" as const } : { result: ((strs + 1) / units) * 100 <= thresh ? "PASS" : "FAIL", after: +(((strs + 1) / units) * 100).toFixed(2) };
  assert.equal(density(3, null, 2).result, "DATA_REQUIRED"); assert.equal(density(3, 0, 2).result, "DATA_REQUIRED");
  const r = density(3, 214, 2); assert.equal(r.result, "PASS"); assert.equal((r as any).after, 1.87);
  assert.equal(density(4, 214, 2).result, "FAIL");
});
