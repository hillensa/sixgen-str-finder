import test from "node:test";
import assert from "node:assert/strict";
import { parseCsv } from "../src/lib/providers/listings";
import { toImportCsv, parsePayload } from "../src/lib/zillow/payload";

test("the importer reads back exactly what the Zillow CSV writes, quotes and all", () => {
  const p = parsePayload(JSON.stringify({ sixgen: "zillow-pull", v: 1, signature: null, total: 1, totalPages: 1, pages: [1],
    homes: [{ zpid: "77", address: 'Unit 2, "The Barn"', zip: "40502", lat: 38.03, lng: -84.49, price: 500000,
      beds: 4, baths: 3, sqft: 2500, lotSqft: 8000, homeType: "SINGLE_FAMILY", dom: 5, photo: null }] }));
  assert.ok(p.ok);
  if (!p.ok) return;
  const rows = parseCsv(toImportCsv(p.value.homes));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].address, 'Unit 2, "The Barn"');
  assert.equal(rows[0].zpid, "77");
  assert.equal(rows[0].property_type, "SF");
});
