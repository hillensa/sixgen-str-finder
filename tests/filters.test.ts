import { test } from "node:test";
import assert from "node:assert/strict";
import { applyHardFilters, hoaStatusFrom } from "../src/lib/filters";

test("3 bedrooms excluded, 4 allowed", () => {
  assert.equal(applyHardFilters({ beds: 3, price: 500000, hoa_status: "VERIFIED_NO_HOA" }).qualified, false);
  assert.equal(applyHardFilters({ beds: 4, price: 500000, hoa_status: "VERIFIED_NO_HOA" }).qualified, true);
});
test("$399,999 excluded, $400,000 allowed", () => {
  assert.equal(applyHardFilters({ beds: 4, price: 399999, hoa_status: "VERIFIED_NO_HOA" }).qualified, false);
  assert.equal(applyHardFilters({ beds: 4, price: 400000, hoa_status: "VERIFIED_NO_HOA" }).qualified, true);
});
test("HOA tri-state: present excluded, unknown → verification list, verified-none allowed", () => {
  const present = applyHardFilters({ beds: 5, price: 600000, hoa_status: "HOA_PRESENT" });
  assert.equal(present.qualified, false); assert.equal(present.needsHoaVerification, false);
  const unknown = applyHardFilters({ beds: 5, price: 600000, hoa_status: "HOA_UNKNOWN" });
  assert.equal(unknown.qualified, false); assert.equal(unknown.needsHoaVerification, true);
  const none = applyHardFilters({ beds: 5, price: 600000, hoa_status: "VERIFIED_NO_HOA" });
  assert.equal(none.qualified, true);
});
test("$0 HOA fee alone is NOT proof of no HOA", () => {
  assert.equal(hoaStatusFrom({ fee: 0 }), "HOA_UNKNOWN");
  assert.equal(hoaStatusFrom({ fee: 25 }), "HOA_PRESENT");
  assert.equal(hoaStatusFrom({ flag: false, verified: true }), "VERIFIED_NO_HOA");
});
test("missing data never silently passes", () => {
  const r = applyHardFilters({ beds: null, price: null, hoa_status: null });
  assert.equal(r.qualified, false); assert.ok(r.reasons.some((x) => /missing/i.test(x)));
});
test("non-active listing excluded", () => {
  assert.equal(applyHardFilters({ beds: 5, price: 700000, hoa_status: "VERIFIED_NO_HOA", status: "pending" }).qualified, false);
});
