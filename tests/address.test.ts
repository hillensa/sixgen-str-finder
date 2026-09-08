import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAddress, composeAddress, normalizeAddress, addressSimilarity } from "../src/lib/address";

test("a one-line address is canonicalized and its ZIP split off", () => {
  const p = parseAddress("697 Cindy Blair Way 40503");
  assert.equal(p.normalized, "697 CINDY BLAIR WAY");
  assert.equal(p.number, "697");
  assert.equal(p.street, "CINDY BLAIR");
  assert.equal(p.suffix, "WAY");
  assert.equal(p.zip, "40503");
  assert.equal(p.unit, null);
});

test("city/state tails and punctuation are stripped", () => {
  assert.equal(normalizeAddress("1234 Main St., Lexington, KY 40502"), "1234 MAIN ST");
  assert.equal(normalizeAddress("1234 Main Street  Lexington KY"), "1234 MAIN ST");
});

test("suffixes and directionals are abbreviated USPS-style", () => {
  assert.equal(normalizeAddress("300 North Broadway Street"), "300 N BROADWAY ST");
  assert.equal(normalizeAddress("42 Willow Drive"), "42 WILLOW DR");
  assert.equal(normalizeAddress("42 Willow Dr"), "42 WILLOW DR");
});

test("the ORR file's five address columns compose to the same canonical string", () => {
  // 2026 tab shape: Street Number · Direction · Street Name · Suffix · Zip
  const composed = composeAddress({ number: "300", direction: "North", street: "Broadway", suffix: "Street", zip: "40508" });
  // 2024 tab shape: one "Property Address" column
  const single = "300 N Broadway St, Lexington, KY 40508";
  assert.equal(normalizeAddress(composed), normalizeAddress(single));
  assert.equal(parseAddress(composed).zip, "40508");
});

test("units are separated from the street address, however they were written", () => {
  assert.equal(parseAddress("102 Rosemont Garden APT 3").unit, "3");
  assert.equal(parseAddress("500 Main St # 2B").unit, "2B");
  assert.equal(parseAddress("3865-B Gladman Way").unit, "B");
  assert.equal(parseAddress("3865-B Gladman Way").number, "3865");
  // the street address itself is identical for every unit in a building
  assert.equal(parseAddress("500 Main St # 2B").normalized, parseAddress("500 Main St # 3C").normalized);
  // …but the dedupe key is not
  assert.notEqual(parseAddress("500 Main St # 2B").key, parseAddress("500 Main St # 3C").key);
});

test("a composed unit survives the round trip", () => {
  const s = composeAddress({ number: "500", street: "Main", suffix: "St", unit: "2B", zip: "40507" });
  const p = parseAddress(s);
  assert.equal(p.normalized, "500 MAIN ST");
  assert.equal(p.unit, "2B");
  assert.equal(p.zip, "40507");
});

test("similarity treats the house number as a hard gate", () => {
  assert.equal(addressSimilarity("697 Cindy Blair Way", "697 Cindy Blair Way"), 1);
  // one digit apart is a different house, not a 97% match
  assert.equal(addressSimilarity("697 Cindy Blair Way", "679 Cindy Blair Way"), 0);
  assert.equal(addressSimilarity("697 Cindy Blair Way", "Cindy Blair Way"), 0);
});

test("similarity ranks the right street above a same-numbered neighbour", () => {
  const right = addressSimilarity("300 N Broadway St", "300 N BROADWAY ST");
  const wrong = addressSimilarity("300 N Broadway St", "300 N BRAODWAY AVE");
  assert.ok(right > wrong, `${right} should beat ${wrong}`);
  assert.ok(right >= 0.9);
});

test("an address with no street number is reported as unparseable rather than guessed", () => {
  const p = parseAddress("Cindy Blair Way");
  assert.equal(p.number, null);
  assert.ok(p.normalized.length > 0);
});

test("empty input never throws", () => {
  for (const v of ["", "   ", ",,,", "—"]) {
    const p = parseAddress(v);
    assert.equal(typeof p.normalized, "string");
  }
});
