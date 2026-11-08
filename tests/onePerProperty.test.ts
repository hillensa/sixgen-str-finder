import test from "node:test";
import assert from "node:assert/strict";
import { onePerProperty, duplicateCount } from "../src/lib/listings/onePerProperty";

test("a house listed by two sources is kept once, as its most recently seen listing", () => {
  const rows = [
    { property_id: 1, listing_id: 10, url: null, src: "mls-september" },
    { property_id: 2, listing_id: 20, url: null, src: "only" },
    { property_id: 1, listing_id: 30, url: "https://z", src: "zillow-today" },
  ];
  const lastSeen = new Map([[10, "2026-09-07T09:00:00Z"], [20, "2026-09-07T09:00:00Z"], [30, "2026-11-07T22:00:00Z"]]);
  const out = onePerProperty(rows, lastSeen);
  assert.deepEqual(out.map((r) => r.src), ["zillow-today", "only"]);
  assert.equal(duplicateCount(rows), 1);
});

test("first-appearance order survives, so a score-sorted list stays sorted", () => {
  const rows = [
    { property_id: 5, listing_id: 1, url: null },
    { property_id: 9, listing_id: 2, url: null },
    { property_id: 5, listing_id: 3, url: null },
  ];
  assert.deepEqual(onePerProperty(rows).map((r) => r.property_id), [5, 9]);
});

test("with no timestamps the listing that can be opened wins, then the newer row", () => {
  const out = onePerProperty([
    { property_id: 1, listing_id: 50, url: null },
    { property_id: 1, listing_id: 40, url: "https://listing" },
  ]);
  assert.equal(out[0].listing_id, 40);
  const tie = onePerProperty([
    { property_id: 1, listing_id: 40, url: null },
    { property_id: 1, listing_id: 50, url: null },
  ]);
  assert.equal(tie[0].listing_id, 50);
});
