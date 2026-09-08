import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  planCoordinates, applyGeocode, coordinateSummary, describeCoordinates,
  type GeocodeHit,
} from "../src/lib/listings/geolocate";
import { parseListingRow, normalizeRow, parseCsv, type ParsedListing } from "../src/lib/providers/listings";
import { diffListings, type ExistingListing } from "../src/lib/listings/diff";
import { writeOutcome } from "../src/lib/listings/outcome";
import { MIN_PARCEL_CONFIDENCE } from "../src/lib/eligibility";

/**
 * An MLS export usually has no lat/lng column. These cover the path that takes
 * such a row from "silently dropped" to "located, or reported as unlocatable".
 */

const row = (over: Record<string, string> = {}) => ({
  address: "697 CINDY BLAIR WAY", price: "425000", beds: "3", ...over,
});
const parse = (over: Record<string, string> = {}) => parseListingRow(row(over)) as ParsedListing;

// ── parsing keeps what it used to throw away ────────────────────────────────
test("a row with no coordinates survives parsing instead of vanishing", () => {
  const p = parseListingRow(row());
  assert.ok(p, "the row must survive so it can be geocoded");
  assert.equal(p!.lat, null);
  assert.equal(p!.lng, null);
  assert.equal(p!.address, "697 CINDY BLAIR WAY");
  assert.equal(p!.price, 425000, "the rest of the row is parsed normally");
});

test("a row with no address is still dropped — there is nothing to geocode", () => {
  assert.equal(parseListingRow({ price: "425000", lat: "38.0", lng: "-84.5" }), null);
});

test("normalizeRow still insists on coordinates, for callers that cannot geocode", () => {
  assert.equal(normalizeRow(row()), null);
  const ok = normalizeRow(row({ lat: "38.0", lng: "-84.5" }));
  assert.equal(ok?.lat, 38.0);
});

test("REGRESSION: a synthetic external id stays coordinate-keyed when a pin exists", () => {
  // ids must not change shape for payloads that already worked, or every row of
  // a re-imported export reads as new
  assert.equal(parse({ lat: "38.012345", lng: "-84.523456" }).externalId, "38.012345,-84.523456");
  assert.equal(parse().externalId, "697 CINDY BLAIR WAY", "no pin: fall back to the normalized address");
  assert.equal(parse({ unit: "2B" }).externalId, "697 CINDY BLAIR WAY#2B", "a unit is part of the identity");
  assert.equal(parse({ id: "MLS-1", lat: "38.0", lng: "-84.5" }).externalId, "MLS-1", "a real id always wins");
});

test("the CSV provider path carries coordinate-less rows through", () => {
  const rows = parseCsv("address,price,beds\n697 Cindy Blair Way,425000,3\n").map(parseListingRow);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.lat, null);
});

// ── tier selection ─────────────────────────────────────────────────────────
test("a coordinate in the payload is used as-is and costs nothing", () => {
  const { located, needGeocode } = planCoordinates([parse({ lat: "38.0", lng: "-84.5" })]);
  assert.equal(needGeocode.length, 0);
  assert.equal(located[0].coordinateSource, "provider");
  assert.equal(located[0].coordinateConfidence, 1);
});

test("a listing we already stored reuses its pin rather than re-geocoding", () => {
  const p = parse({ id: "MLS-1" });
  const known = new Map([["MLS-1", { lat: 38.1, lng: -84.6 }]]);
  const { located, needGeocode } = planCoordinates([p], known);
  assert.equal(needGeocode.length, 0, "a known listing must not spend a geocode call");
  assert.equal(located[0].lat, 38.1);
  assert.equal(located[0].coordinateSource, "known_property");
});

test("a stored property with no usable pin still goes to the geocoder", () => {
  const known = new Map([["MLS-1", { lat: null, lng: null }]]);
  const { located, needGeocode } = planCoordinates([parse({ id: "MLS-1" })], known);
  assert.equal(located.length, 0);
  assert.equal(needGeocode.length, 1);
});

// ── geocoder results ───────────────────────────────────────────────────────
const hit = (over: Partial<GeocodeHit> = {}): GeocodeHit =>
  ({ lat: 38.0, lng: -84.5, confidence: 0.97, method: "address_point", ...over });

test("a geocoded row carries the method and confidence that produced it", () => {
  const p = parse({ id: "MLS-1" });
  const { located, unresolved } = applyGeocode([p], new Map([["697 CINDY BLAIR WAY", hit()]]), () => "697 CINDY BLAIR WAY");
  assert.equal(unresolved.length, 0);
  assert.equal(located[0].coordinateSource, "address_point");
  assert.equal(located[0].coordinateConfidence, 0.97);
});

test("a Census result keeps its lower confidence rather than being rounded up", () => {
  const { located } = applyGeocode([parse()], new Map([["k", hit({ confidence: 0.7, method: "census" })]]), () => "k");
  assert.equal(located[0].coordinateConfidence, 0.7);
  assert.equal(located[0].coordinateSource, "census");
});

test("an interpolated pin stays below the parcel-confidence threshold", () => {
  // fn_link_properties_to_parcels caps parcel_match_confidence by this number.
  // If Census confidence ever rose above MIN_PARCEL_CONFIDENCE, an interpolated
  // coordinate would silently start reading as a surveyed one.
  const CENSUS_MAX = 0.7;   // src/lib/geocode.ts, fromCensus
  assert.ok(CENSUS_MAX < MIN_PARCEL_CONFIDENCE,
    "a Census pin must trip LOW_PARCEL_CONFIDENCE, not pass as surveyed");
});

test("a miss is reported with a reason, never written with a null pin", () => {
  const { located, unresolved } = applyGeocode([parse({ id: "MLS-9" })], new Map([["k", null]]), () => "k");
  assert.equal(located.length, 0);
  assert.equal(unresolved[0].externalId, "MLS-9");
  assert.match(unresolved[0].reason, /latitude\/longitude|could not be geocoded/i);
});

// ── reporting ──────────────────────────────────────────────────────────────
test("the summary separates interpolated pins from surveyed ones", () => {
  const { located } = applyGeocode(
    [parse({ id: "a" }), parse({ id: "b" })],
    new Map([["a", hit()], ["b", hit({ confidence: 0.6, method: "census" })]]),
    (addr) => (addr === "697 CINDY BLAIR WAY" ? "a" : "b"),
  );
  // both rows share an address here, so drive the keys apart explicitly
  const s = coordinateSummary(
    [{ ...located[0], coordinateSource: "address_point" }, { ...located[0], coordinateSource: "census" }],
    [{ externalId: "c", address: "x", reason: "nope" }],
  );
  assert.deepEqual(s, { provider: 0, knownProperty: 0, addressPoint: 1, census: 1, unresolved: 1 });
  const text = describeCoordinates(s);
  assert.match(text, /approximate/, "a Census pin must be labelled approximate in the operator's message");
  assert.match(text, /1 could not be located/);
});

test("nothing is said when every row arrived with its own pin", () => {
  assert.equal(describeCoordinates(coordinateSummary([], [])), "");
});

// ── the removal guard ──────────────────────────────────────────────────────
const existing = (externalId: string): ExistingListing => ({
  id: 1, externalId, propertyId: 10, status: "active", listPrice: 400000,
  originalPrice: 400000, removedAt: null,
});

test("REGRESSION: a full sync does not withdraw a listing the geocoder merely missed", () => {
  // It was in the payload. Reporting it as removed would turn a geocoder miss
  // into a false "no longer for sale".
  const d = diffListings([existing("MLS-1")], [], { fullSync: true, protect: new Set(["MLS-1"]) });
  assert.equal(d.counts.removed, 0);
});

test("a full sync still withdraws a listing that really is absent", () => {
  const d = diffListings([existing("MLS-1")], [], { fullSync: true, protect: new Set(["MLS-2"]) });
  assert.equal(d.counts.removed, 1);
  assert.match(d.changes[0].reason, /Absent from a full refresh/);
});

// ── migration guard ────────────────────────────────────────────────────────
test("REGRESSION: parcel match confidence is capped by the coordinate's confidence", () => {
  const raw = readFileSync(join(__dirname, "..", "supabase", "migrations", "0008_listing_geocoding.sql"), "utf8");
  // scan the statements, not the commentary that explains them
  const s = raw.replace(/--[^\n]*/g, "");
  assert.ok(/least\(0\.95, coalesce\(pr\.geocode_confidence, 0\.95\)\)/.test(s),
    "a point-in-polygon hit is only as good as the point that produced it");
  assert.ok(!/parcel_match_confidence = 0\.95\b/.test(s), "the flat 0.95 must not come back");
  assert.ok(/add column if not exists geocode_method/.test(s) &&
            /add column if not exists geocode_confidence/.test(s),
    "provenance columns must be additive so the migration can re-run");
});

// ── write outcome ──────────────────────────────────────────────────────────
test("REGRESSION: a refresh that wrote nothing is an error, not a quiet success", () => {
  // The live test hit this: 6 rows failed on a missing column, and the response
  // still came back 200 with `upserted: 6`. A cron would have seen a success.
  const o = writeOutcome(6, 0, Array(6).fill("Could not find the 'geocode_confidence' column"));
  assert.equal(o.ok, false);
  assert.match(o.error!, /All 6 listings failed to write/);
  assert.match(o.error!, /geocode_confidence/, "the operator needs the cause, not just the count");
});

test("identical failures are reported once, not six times", () => {
  const o = writeOutcome(6, 0, Array(6).fill("same problem"));
  assert.equal((o.error!.match(/same problem/g) ?? []).length, 1);
});

test("a partial failure is still a successful run", () => {
  assert.equal(writeOutcome(6, 5, ["one bad row"]).ok, true, "five listings did land");
});

test("a refresh with nothing to write is not an error", () => {
  assert.equal(writeOutcome(0, 0, []).ok, true);
  assert.equal(writeOutcome(3, 0, []).ok, true, "no failures recorded means nothing went wrong");
});
