import test from "node:test";
import assert from "node:assert/strict";
import { distanceFt, nearestPermits } from "../src/lib/gis/distance";

test("a known separation comes back in feet", () => {
  // One minute of latitude is a nautical mile: 6,076.1 ft.
  const d = distanceFt({ lat: 38.0, lng: -84.5 }, { lat: 38.0 + 1 / 60, lng: -84.5 });
  assert.ok(Math.abs(d - 6076) < 15, `expected ~6076 ft, got ${d}`);
  assert.equal(distanceFt({ lat: 38, lng: -84.5 }, { lat: 38, lng: -84.5 }), 0);
});

test("the nearest permits come back nearest first", () => {
  const subject = { lat: 38.0, lng: -84.5 };
  const permits = [
    { id: 3, lat: 38.01, lng: -84.5 },     // ~3,650 ft
    { id: 1, lat: 38.0005, lng: -84.5 },   // ~180 ft
    { id: 2, lat: 38.002, lng: -84.5 },    // ~730 ft
  ];
  const { nearest } = nearestPermits(subject, permits, 2);
  assert.deepEqual(nearest.map((p) => p.id), [1, 2]);
  assert.ok(nearest[0].distance_ft < nearest[1].distance_ft);
});

test("an un-geocoded permit is skipped and counted, never sorted to an end", () => {
  // Sorting a null distance to the front would make it look like the nearest
  // STR; to the back, like the furthest. Both are claims the data cannot make.
  const { nearest, located, unlocated } = nearestPermits(
    { lat: 38.0, lng: -84.5 },
    [{ id: 1, lat: null, lng: null }, { id: 2, lat: 38.0005, lng: -84.5 }],
  );
  assert.deepEqual(nearest.map((p) => p.id), [2]);
  assert.equal(located, 1);
  assert.equal(unlocated, 1);
});
