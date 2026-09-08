import { monthlyKey, changedMonthlyRows, sameMonthlyReading, type MonthlyMetrics } from "../src/lib/import/sixgen";
import { test } from "node:test";
import assert from "node:assert/strict";
import { suggestMapping, validateMapping, mappingWarnings, parseStrType, parsePermitStatus, parseDate } from "../src/lib/import/columns";
import { normalizePermitRows, matchStatusFor, permitExternalId } from "../src/lib/import/permits";

// The two shapes the ORR-2026-1259 file actually ships in.
const ORR_2026 = ["Owner Name", "Hosted/Unhosted", "Owner(s)", "Occupation License #", "STR License #",
  "Street Number", "Unit", "Direction", "Street Name", "Suffix", "Zip", "Emergency Contact", "Phone",
  "Insurance Expiration", "Notes"];
const ORR_2024 = ["Property Address", "Hosted or Unhosted", "License Number", "Status"];

test("the 2026 tab's five address columns are detected as a composite address", () => {
  const { mapping } = suggestMapping(ORR_2026);
  assert.equal(mapping.address_number, "street_number");
  assert.equal(mapping.address_street, "street_name");
  assert.equal(mapping.address_suffix, "suffix");
  assert.equal(mapping.address_direction, "direction");
  assert.equal(mapping.address_unit, "unit");
  assert.equal(mapping.zip, "zip");
  assert.equal(mapping.str_type, "hosted_unhosted");
  assert.equal(mapping.permit_number, "str_license");
  assert.equal(mapping.occupation_license, "occupation_license");
  assert.equal(mapping.address_full, undefined, "a split-address file must not also claim a full-address column");
  assert.deepEqual(validateMapping(mapping, ORR_2026), []);
});

test("the 2024 tab's single address column maps too — proving columns are never assumed", () => {
  const { mapping } = suggestMapping(ORR_2024);
  assert.equal(mapping.address_full, "property_address");
  assert.equal(mapping.str_type, "hosted_or_unhosted");
  assert.equal(mapping.permit_status, "status");
  assert.deepEqual(validateMapping(mapping, ORR_2024), []);
});

test("a mapping with no address and no type is rejected before anything is written", () => {
  const errors = validateMapping({}, ["a", "b"]);
  assert.equal(errors.length, 2);
  assert.ok(errors.some((e) => /full address column/.test(e)));
  assert.ok(errors.some((e) => /hosted/.test(e)));
});

test("a column mapped twice is rejected, and a column that is not in the file is rejected", () => {
  const dupe = validateMapping({ address_full: "addr", notes: "addr", str_type: "t" }, ["addr", "t"]);
  assert.ok(dupe.some((e) => /mapped to 2 fields/.test(e)));
  const missing = validateMapping({ address_full: "nope", str_type: "t" }, ["addr", "t"]);
  assert.ok(missing.some((e) => /not a column in this file/.test(e)));
});

test("warnings name the consequences instead of just the gap", () => {
  const w = mappingWarnings({ address_full: "a", str_type: "t" }, ["extra"]);
  assert.ok(w.some((x) => /counts as blocking/.test(x)), "missing status must say it blocks");
  assert.ok(w.some((x) => /unmapped/.test(x)));
});

test("hosted/un-hosted is read from whatever the file writes — and 'unknown' stays unknown", () => {
  for (const v of ["U", "Un-Hosted", "UNHOSTED", "unhosted", "Not Hosted", "N"]) assert.equal(parseStrType(v), "unhosted", v);
  for (const v of ["H", "Hosted", "HOSTED", "Y"]) assert.equal(parseStrType(v), "hosted", v);
  // this is the failure that would empty the whole exclusion map: never guess
  for (const v of ["", "  ", "Unknown", "N/A", "TBD", "Whole Home"]) assert.equal(parseStrType(v), null, v);
});

test("an unrecognized permit status is 'unknown', never 'active'", () => {
  assert.equal(parsePermitStatus("Active"), "active");
  assert.equal(parsePermitStatus("ISSUED"), "active");
  assert.equal(parsePermitStatus("Expired 3/2024"), "expired");
  assert.equal(parsePermitStatus("Under review"), "pending");
  assert.equal(parsePermitStatus("Revoked"), "revoked");
  assert.equal(parsePermitStatus(""), "unknown");
  assert.equal(parsePermitStatus("¯\\_(ツ)_/¯"), "unknown");
});

test("dates parse from US, ISO, and Excel-serial forms", () => {
  assert.equal(parseDate("1/15/2024"), "2024-01-15");
  assert.equal(parseDate("2024-01-15"), "2024-01-15");
  assert.equal(parseDate("45306"), "2024-01-15");
  assert.equal(parseDate(""), null);
  assert.equal(parseDate("not a date"), null);
});

// ── the normalization pipeline ──────────────────────────────────────────────
const MAPPING = {
  permit_number: "str_license", str_type: "hosted_unhosted", permit_status: "status",
  address_number: "street_number", address_direction: "direction", address_street: "street_name",
  address_suffix: "suffix", address_unit: "unit", zip: "zip",
} as const;

const row = (o: Partial<Record<string, string>>) => ({
  str_license: "", hosted_unhosted: "", status: "", street_number: "", direction: "",
  street_name: "", suffix: "", unit: "", zip: "", ...o,
}) as Record<string, string>;

test("split columns normalize to one canonical address per row", () => {
  const { rows, counts } = normalizePermitRows([
    row({ str_license: "STR-1", hosted_unhosted: "Unhosted", status: "Active", street_number: "697", street_name: "Cindy Blair", suffix: "Way", zip: "40503" }),
    row({ str_license: "STR-2", hosted_unhosted: "Hosted", status: "Active", street_number: "300", direction: "North", street_name: "Broadway", suffix: "Street", zip: "40508" }),
  ], MAPPING as any);

  assert.equal(counts.ready, 2);
  assert.equal(rows[0].addressNorm, "697 CINDY BLAIR WAY");
  assert.equal(rows[0].zip, "40503");
  assert.equal(rows[0].strType, "unhosted");
  assert.equal(rows[0].permitStatus, "active");
  assert.equal(rows[1].addressNorm, "300 N BROADWAY ST");
  assert.equal(rows[1].strType, "hosted");
});

test("a row with no street number is invalid, not silently geocoded to the street", () => {
  const { rows, counts } = normalizePermitRows([
    row({ str_license: "STR-9", hosted_unhosted: "U", street_name: "Cindy Blair", suffix: "Way" }),
  ], MAPPING as any);
  assert.equal(counts.invalid, 1);
  assert.equal(rows[0].status, "invalid");
  assert.ok(rows[0].errors[0].includes("No street number"));
});

test("duplicates are flagged by license number and by address+unit, and point at the row they duplicate", () => {
  const { rows, counts } = normalizePermitRows([
    row({ str_license: "STR-1", hosted_unhosted: "U", street_number: "697", street_name: "Cindy Blair", suffix: "Way" }),
    row({ str_license: "STR-1", hosted_unhosted: "U", street_number: "42", street_name: "Willow", suffix: "Dr" }),
    row({ str_license: "STR-3", hosted_unhosted: "U", street_number: "697", street_name: "Cindy Blair", suffix: "Way" }),
    row({ str_license: "STR-4", hosted_unhosted: "U", street_number: "697", street_name: "Cindy Blair", suffix: "Way", unit: "2B" }),
  ], MAPPING as any);

  assert.equal(counts.duplicate, 2);
  assert.equal(rows[1].status, "duplicate");
  assert.equal(rows[1].duplicateOfRow, 1);
  assert.equal(rows[2].status, "duplicate");
  assert.equal(rows[2].duplicateOfRow, 1);
  // a different unit at the same street address is a different permit
  assert.equal(rows[3].status, "ready");
});

test("an unclassifiable hosted/un-hosted value is counted, not dropped or guessed", () => {
  const { rows, counts } = normalizePermitRows([
    row({ str_license: "STR-1", hosted_unhosted: "???", street_number: "697", street_name: "Cindy Blair", suffix: "Way" }),
  ], MAPPING as any);
  assert.equal(rows[0].status, "ready", "it still imports");
  assert.equal(rows[0].strType, null, "but it is not guessed");
  assert.equal(counts.unclassified, 1, "and the operator is told how many");
});

test("external ids are stable, so re-importing the same file updates instead of duplicating", () => {
  const a = normalizePermitRows([row({ str_license: "STR-1", hosted_unhosted: "U", street_number: "697", street_name: "Cindy Blair", suffix: "Way" })], MAPPING as any);
  const b = normalizePermitRows([row({ str_license: "STR-1", hosted_unhosted: "U", street_number: "697", street_name: "Cindy Blair ", suffix: "way" })], MAPPING as any);
  assert.equal(a.rows[0].externalId, b.rows[0].externalId);
  assert.equal(permitExternalId({ permitNumber: null, addressNorm: "697 CINDY BLAIR WAY", unit: null }), "addr:697 CINDY BLAIR WAY");
});

test("only a high-confidence hit is called 'matched'", () => {
  assert.equal(matchStatusFor(0.97, true), "matched");
  assert.equal(matchStatusFor(0.9, true), "matched");
  assert.equal(matchStatusFor(0.7, true), "possible", "a Census interpolation is never 'matched'");
  assert.equal(matchStatusFor(null, false), "unmatched");
  assert.equal(matchStatusFor(0.99, false), "unmatched", "confidence without coordinates is meaningless");
});

// ── re-importing an unchanged export ────────────────────────────────────────
// Appending a full generation per run added 408 rows of identical numbers each
// time; three runs had to be pruned by hand. The `imports` table already records
// that a run happened.
const mMetrics = (over: Partial<MonthlyMetrics> = {}) => ({
  reservations: 3, occupied_nights: 21, available_nights: 30,
  occupancy: 0.7, adr: 500, revpar: 350, gross_revenue: 10500, ...over,
});
const mRow = (pid: number, year: number, month: number, over: Partial<MonthlyMetrics> = {}) =>
  ({ sixgen_property_id: pid, year, month, ...mMetrics(over) });

test("re-importing an unchanged export writes nothing", () => {
  const payload = [mRow(1, 2026, 1), mRow(1, 2026, 2)];
  const newest = new Map(payload.map((r) => [monthlyKey(r.sixgen_property_id, r.year, r.month), r]));
  assert.deepEqual(changedMonthlyRows(payload, newest), []);
});

test("a corrected number is still written, so real history is never lost", () => {
  const payload = [mRow(1, 2026, 1), mRow(1, 2026, 2, { gross_revenue: 12000 })];
  const newest = new Map([
    [monthlyKey(1, 2026, 1), mMetrics()],
    [monthlyKey(1, 2026, 2), mMetrics()],
  ]);
  const changed = changedMonthlyRows(payload, newest);
  assert.equal(changed.length, 1);
  assert.equal(changed[0].month, 2, "only the month whose revenue moved");
});

test("a listing-month never seen before is always written", () => {
  assert.equal(changedMonthlyRows([mRow(9, 2026, 5)], new Map()).length, 1);
});

test("numerics that arrive from Postgres as strings are not read as changes", () => {
  // occupancy/adr/revpar are `numeric`, and PostgREST returns them as strings.
  // Comparing them raw would mark every row changed and defeat the whole thing.
  const stored = { ...mMetrics(), occupancy: "0.70000" as any, adr: "500.00" as any, gross_revenue: "10500.00" as any };
  assert.equal(sameMonthlyReading(mRow(1, 2026, 1), stored), true);
});

test("a null reading and a zero reading are not the same measurement", () => {
  assert.equal(sameMonthlyReading(mMetrics({ reservations: null }), mMetrics({ reservations: 0 })), false);
  assert.equal(sameMonthlyReading(mMetrics({ reservations: null }), mMetrics({ reservations: null })), true);
});
