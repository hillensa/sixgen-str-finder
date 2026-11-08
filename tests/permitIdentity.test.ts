import test from "node:test";
import assert from "node:assert/strict";
import { permitIdentity, dedupeByIdentity, reconcileWithPrior, missingFrom } from "../src/lib/permitIdentity";

// The real cases from the LFUCG layer, 2026-11-07.
const steamboat = { permit_number: "15087540-1", address_norm: "4277 STEAMBOAT RD" };
const chinoe = { permit_number: "15087540-1", address_norm: "415 CHINOE RD" };
const swigert = { permit_number: "15086391-1", address_norm: "194 SWIGERT AVE" };

test("one permit number covering two houses stays two permits", () => {
  // Merging them would drop an unhosted STR from the spacing test.
  assert.notEqual(permitIdentity(steamboat), permitIdentity(chinoe));
  const { rows, collapsed } = dedupeByIdentity([steamboat, chinoe]);
  assert.equal(rows.length, 2);
  assert.equal(collapsed, 0);
});

test("a row the layer repeats outright collapses to one", () => {
  const { rows, collapsed } = dedupeByIdentity([swigert, { ...swigert }, steamboat]);
  assert.equal(rows.length, 2);
  assert.equal(collapsed, 1);
});

test("identity ignores address case and padding, and a missing permit number has none", () => {
  assert.equal(permitIdentity({ permit_number: " 1-1 ", address_norm: "1 main st " }), permitIdentity({ permit_number: "1-1", address_norm: "1 MAIN ST" }));
  assert.equal(permitIdentity({ permit_number: null, address_norm: "1 MAIN ST" }), null);
});

test("a renumbered layer updates the stored rows instead of inserting copies", () => {
  const prior = [
    { id: 155, external_id: "10451", ...steamboat },
    { id: 156, external_id: "10452", ...chinoe },
  ];
  // same two permits, new ObjectIDs, delivered in the other order
  const incoming = [
    { external_id: "11187", review_note: null, ...chinoe },
    { external_id: "11188", review_note: null, ...steamboat },
  ];
  const out = reconcileWithPrior(incoming, prior);
  assert.deepEqual(out.map((r) => [r.address_norm, r.id, r.external_id]), [
    ["415 CHINOE RD", 156, "10452"],
    ["4277 STEAMBOAT RD", 155, "10451"],
  ]);
  assert.equal(missingFrom(prior, out).length, 0, "nothing is reported as vanished");
});

test("a permit genuinely gone from the layer is reported, by identity", () => {
  const prior = [{ id: 1, external_id: "a", ...steamboat }, { id: 2, external_id: "b", ...chinoe }];
  assert.deepEqual(missingFrom(prior, [steamboat]).map((r) => r.id), [2]);
});

test("an address the city corrects on an existing permit updates that permit", () => {
  // 15063018-1: 1010 Cramer Ave unit 120 became unit 201 between pulls.
  const prior = [{ id: 189, external_id: "10485", permit_number: "15063018-1", address_norm: "1010 CRAMER AVENUE 120" }];
  const incoming = [{ external_id: "11221", review_note: null, permit_number: "15063018-1", address_norm: "1010 CRAMER AVENUE 201" }];
  const out = reconcileWithPrior(incoming, prior);
  assert.equal(out[0].id, 189, "the stored row is updated, not duplicated");
  assert.equal(out[0].address_norm, "1010 CRAMER AVENUE 201", "and takes the corrected address");
  assert.equal(missingFrom(prior, out).length, 0, "so it is not also reported as vanished");
});

test("an ambiguous change is left as a new permit rather than guessed", () => {
  // two unmatched incoming rows under one number, one stored orphan: no guess
  const prior = [{ id: 1, external_id: "a", permit_number: "9-1", address_norm: "1 OLD RD" }];
  const incoming = [
    { external_id: "x", review_note: null, permit_number: "9-1", address_norm: "2 NEW RD" },
    { external_id: "y", review_note: null, permit_number: "9-1", address_norm: "3 NEW RD" },
  ];
  const out = reconcileWithPrior(incoming, prior);
  assert.ok(out.every((r) => r.id === undefined));
  assert.deepEqual(missingFrom(prior, out).map((r) => r.id), [1], "the old one is flagged, and keeps blocking");
});

test("the two-house permit is untouched by the correction pass", () => {
  const prior = [
    { id: 155, external_id: "10451", permit_number: "15087540-1", address_norm: "4277 STEAMBOAT RD" },
    { id: 156, external_id: "10452", permit_number: "15087540-1", address_norm: "415 CHINOE RD" },
  ];
  const incoming = [
    { external_id: "n1", review_note: null, permit_number: "15087540-1", address_norm: "4277 STEAMBOAT RD" },
    { external_id: "n2", review_note: null, permit_number: "15087540-1", address_norm: "415 CHINOE RD" },
  ];
  assert.deepEqual(reconcileWithPrior(incoming, prior).map((r) => r.id), [155, 156]);
});
