import test from "node:test";
import assert from "node:assert/strict";
import { planParcelWrites } from "../src/lib/gis/parcelStore";

const row = (pva: string | null, obj: number | null) => ({ jurisdiction_id: "lfucg", pva_id: pva, source_object_id: obj, address: "x" });

test("a renumbered layer updates the stored parcel instead of inserting a copy", () => {
  // 227 E High St: ObjectID 53359257 in September, 54960561 in November.
  const plan = planParcelWrites([row("16309500", 54960561)], [{ id: 355, pva_id: "16309500", source_object_id: 53359257 }]);
  assert.equal(plan.inserts.length, 0);
  assert.deepEqual(plan.updates.map((u) => [u.id, u.source_object_id]), [[355, 54960561]]);
  assert.deepEqual(plan.release, []);
});

test("an ObjectID reassigned to a different parcel is released from the stale row first", () => {
  // after a republish, parcel B arrives with the ObjectID parcel A used to hold;
  // without the release the (jurisdiction, source_object_id) unique key refuses B
  const plan = planParcelWrites(
    [row("B", 500)],
    [{ id: 1, pva_id: "A", source_object_id: 500 }, { id: 2, pva_id: "B", source_object_id: 900 }],
  );
  assert.deepEqual(plan.release, [1]);
  assert.deepEqual(plan.updates.map((u) => u.id), [2]);
});

test("a brand-new parcel is inserted, and still releases a stale holder of its ObjectID", () => {
  const plan = planParcelWrites([row("NEW", 500)], [{ id: 1, pva_id: "A", source_object_id: 500 }]);
  assert.equal(plan.inserts.length, 1);
  assert.deepEqual(plan.release, [1]);
});

test("a parcel repeated within one batch is written once", () => {
  const plan = planParcelWrites([row("P", 1), row("P", 1), row("Q", 2)], []);
  assert.equal(plan.inserts.length, 2);
  assert.equal(plan.collapsed, 1);
});

test("a parcel with no PVA number can only be matched on its ObjectID", () => {
  const plan = planParcelWrites([row(null, 77)], [{ id: 9, pva_id: null, source_object_id: 77 }]);
  assert.deepEqual(plan.updates.map((u) => u.id), [9]);
  assert.deepEqual(plan.release, [], "it does not release the row it is updating");
});

test("where duplicates already exist, the oldest row for a PVA number is the one updated", () => {
  const plan = planParcelWrites([row("P", 3)], [{ id: 20, pva_id: "P", source_object_id: 2 }, { id: 10, pva_id: "P", source_object_id: 1 }]);
  assert.deepEqual(plan.updates.map((u) => u.id), [10]);
});
