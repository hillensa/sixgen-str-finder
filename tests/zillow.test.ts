import test from "node:test";
import assert from "node:assert/strict";
import { parseCriteria, zillowSearchUrl, filterSignature, signatureFromZillowFilters, DEFAULT_CRITERIA } from "../src/lib/zillow/criteria";
import { parsePayload, mergePayloads, isComplete, applyCriteria, matchesCriteria, toImportCsv, type ZillowPayload } from "../src/lib/zillow/payload";

const home = (zpid: string, beds = 4, baths = 3, extra: Record<string, unknown> = {}) => ({
  zpid, address: `${zpid} Main St`, zip: "40502", lat: 38.03, lng: -84.49, price: 500000,
  beds, baths, sqft: 2500, lotSqft: 8000, homeType: "SINGLE_FAMILY", dom: 5,
  photo: "https://photos.zillowstatic.com/fp/abc123-p_e.jpg", ...extra,
});
const payload = (o: Partial<ZillowPayload> & { homes: any[] }) => JSON.stringify({
  sixgen: "zillow-pull", v: 1, signature: "beds>=4|baths>=3|hoa<=0", total: o.homes.length, totalPages: 1, pages: [1], ...o,
});

test("criteria default to 4 bed / 3 bath / no HOA and reject nonsense", () => {
  assert.deepEqual(parseCriteria({}), { ok: true, value: DEFAULT_CRITERIA });
  assert.deepEqual(parseCriteria({ bedsMin: "5", bathsMin: 2 }), { ok: true, value: { bedsMin: 5, bathsMin: 2, hoaMax: 0 } });
  assert.equal(parseCriteria({ bedsMin: 0 }).ok, false);
  assert.equal(parseCriteria({ bathsMin: 2.5 }).ok, false);
  assert.equal(parseCriteria({ bedsMin: "abc" }).ok, false);
});

test("the search URL carries the criteria in the form Zillow echoes back", () => {
  const c = { bedsMin: 5, bathsMin: 4, hoaMax: 0 };
  const state = JSON.parse(decodeURIComponent(zillowSearchUrl(c).split("searchQueryState=")[1]));
  assert.deepEqual(state.filterState.beds, { min: 5 });
  assert.deepEqual(state.filterState.baths, { min: 4 });
  assert.deepEqual(state.filterState.hoa, { max: 0 });
  // what a Zillow page reports for that search must match what Sixgen saved
  assert.equal(signatureFromZillowFilters({ beds: { min: 5, max: null }, baths: { min: 4 }, hoa: { max: 0 } }), filterSignature(c));
  assert.equal(signatureFromZillowFilters({ beds: { min: 5 } }), null, "a missing filter is not a match");
});

test("a paste that is not from the bookmark is refused, with a reason", () => {
  assert.equal(parsePayload("hello").ok, false);
  assert.equal(parsePayload(JSON.stringify({ homes: [] })).ok, false);
});

test("malformed or out-of-county rows are dropped and counted, not imported", () => {
  const r = parsePayload(payload({ homes: [home("1"), home("x"), home("2", 4, 3, { lat: 40.7, lng: -74.0 }), home("3", 4, 3, { address: "" })] }));
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.value.homes.map((h) => h.zpid), ["1"]);
  assert.equal(r.dropped, 3);
});

test("only Zillow's image host is accepted as a photo", () => {
  const r = parsePayload(payload({ homes: [home("1", 4, 3, { photo: "https://evil.example/x.jpg" })] }));
  assert.ok(r.ok && r.value.homes[0].photo === null);
});

test("pages of one search merge by zpid; a different search starts over", () => {
  const a = (parsePayload(payload({ homes: [home("1"), home("2")], pages: [1], totalPages: 2, total: 3 })) as any).value;
  const b = (parsePayload(payload({ homes: [home("2"), home("3")], pages: [2], totalPages: 2, total: 3 })) as any).value;
  const m = mergePayloads(a, b);
  assert.deepEqual(m.homes.map((h) => h.zpid).sort(), ["1", "2", "3"]);
  assert.deepEqual(m.pages, [1, 2]);
  assert.equal(isComplete(m), true);

  const other = (parsePayload(payload({ homes: [home("9")], signature: "beds>=5|baths>=3|hoa<=0" })) as any).value;
  assert.deepEqual(mergePayloads(m, other).homes.map((h) => h.zpid), ["9"]);
});

test("a pull missing a page is never complete, so it can never full-sync", () => {
  const p = (parsePayload(payload({ homes: [home("1"), home("2"), home("3")], pages: [1, 3], totalPages: 3, total: 3 })) as any).value;
  assert.equal(isComplete(p), false);
  const short = (parsePayload(payload({ homes: [home("1")], pages: [1], totalPages: 1, total: 10 })) as any).value;
  assert.equal(isComplete(short), false, "page count alone is not enough; the homes must add up");
});

test("criteria are re-applied to the rows, and the Zillow filters must match what is saved", () => {
  const p = (parsePayload(payload({ homes: [home("1", 4, 3), home("2", 3, 3), home("3", 4, 2)] })) as any).value;
  const { kept, rejected } = applyCriteria(p.homes, DEFAULT_CRITERIA);
  assert.deepEqual(kept.map((h) => h.zpid), ["1"]);
  assert.equal(rejected.length, 2);
  assert.equal(matchesCriteria(p, DEFAULT_CRITERIA), true);
  assert.equal(matchesCriteria(p, { bedsMin: 5, bathsMin: 3, hoaMax: 0 }), false);
});

test("the import CSV rebuilds the listing URL from the zpid and quotes awkward fields", () => {
  const p = (parsePayload(payload({ homes: [home("77", 4, 3, { address: 'Unit 2, "The Barn"' })] })) as any).value;
  const csv = toImportCsv(p.homes);
  assert.match(csv, /^zpid,address,zip,lat,lng,price,beds,baths,sqft,lot_sqft,property_type,dom,status,url,photo\n/);
  assert.match(csv, /"Unit 2, ""The Barn"""/);
  assert.match(csv, /https:\/\/www\.zillow\.com\/homedetails\/77_zpid\//);
  assert.match(csv, /,SF,/, "Zillow's SINGLE_FAMILY maps to the MLS's SF");
});
