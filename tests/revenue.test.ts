import { test } from "node:test";
import assert from "node:assert/strict";
import { projectRevenue, normalizeOccupancy, buildScenarios, monthlyFromSeasonality, LEXINGTON_SEASONALITY, grossYieldPct } from "../src/lib/revenue";

test("Revenue = ADR × Occupancy × Available Nights (spec example: $825 × 67% × 365)", () => {
  // 825 × 0.67 × 365 = 201,753.75 → 201,754. (The spec text shows $201,829, which is an arithmetic slip; the formula is what matters.)
  assert.equal(projectRevenue(825, 0.67, 365, 1), 201754);
});
test("percentage occupancy is normalized (67 → 0.67)", () => {
  assert.equal(normalizeOccupancy(67), 0.67); assert.equal(normalizeOccupancy(0.67), 0.67);
  assert.equal(projectRevenue(825, 67, 365, 1), 201754);
});
test("occupancy ceiling is enforced", () => {
  assert.equal(projectRevenue(1000, 0.95, 365, 0.82), Math.round(1000 * 0.82 * 365));
});
test("missing/invalid data yields 0, never NaN", () => {
  assert.equal(projectRevenue(NaN, 0.6), 0); assert.equal(projectRevenue(500, NaN), 0); assert.equal(projectRevenue(-1, 0.5), 0);
});
test("scenarios are ordered conservative < base < upside", () => {
  const s = buildScenarios({ adr: 790, occupancy: 0.65 }, { adrP25: 690, adrP75: 895, occP25: 0.58, occP75: 0.72 }, 365, 1);
  assert.ok(s.conservative.revenue < s.base.revenue && s.base.revenue < s.upside.revenue);
  assert.equal(s.conservative.revenue, 146073); assert.equal(s.upside.revenue, 235206);
});
test("monthly projections reconcile exactly to annual", () => {
  const rows = monthlyFromSeasonality(187428, 790, LEXINGTON_SEASONALITY);
  assert.equal(rows.length, 12); assert.equal(rows.reduce((a, r) => a + r.revenue, 0), 187428);
  assert.ok(rows[3].revenue > rows[0].revenue, "April (Keeneland) > January");
});
test("gross yield", () => { assert.equal(grossYieldPct(238000, 725000), 32.8); assert.equal(grossYieldPct(1000, 0), 0); });
