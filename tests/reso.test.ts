import { test } from "node:test";
import assert from "node:assert/strict";
import { resoToListing, monthlyFee, mapStatus, fetchResoListings } from "../src/lib/providers/reso";

/**
 * The mapping is the part that will need correcting once a real ImagineMLS
 * payload arrives, so it is tested as a pure function against records shaped
 * like the RESO Data Dictionary.
 */

const rec = (over: Record<string, any> = {}) => ({
  ListingKey: "20260908123456789012345678",
  ListingId: "25-1234",
  UnparsedAddress: "697 Cindy Blair Way",
  PostalCode: "40509",
  Latitude: 38.012345,
  Longitude: -84.523456,
  ListPrice: 429900,
  BedroomsTotal: 4,
  BathroomsTotalInteger: 3,
  LivingArea: 2793,
  YearBuilt: 1998,
  PropertySubType: "Single Family Residence",
  StandardStatus: "Active",
  PublicRemarks: "A house.",
  ListOfficeName: "Bluegrass Realty",
  ...over,
});

// ── identity ────────────────────────────────────────────────────────────────
test("identity uses ListingKey, not the reusable MLS number", () => {
  // ListingId is what an agent quotes and some MLSs recycle it across
  // relistings. external_id feeds the diff, so it must be the stable key.
  const l = resoToListing(rec())!;
  assert.equal(l.externalId, "20260908123456789012345678");
  assert.equal(l.raw.MlsNumber, "25-1234", "the MLS number is kept, just not as identity");
});

test("a record with no address is dropped — nothing can identify it", () => {
  assert.equal(resoToListing(rec({ UnparsedAddress: null })), null);
});

test("an address is composed from parts when UnparsedAddress is absent", () => {
  const l = resoToListing(rec({
    UnparsedAddress: null, StreetNumber: "697", StreetName: "Cindy Blair", StreetSuffix: "Way",
  }))!;
  assert.equal(l.address, "697 Cindy Blair Way");
});

// ── the HOA trap ────────────────────────────────────────────────────────────
test("REGRESSION: AssociationYN false never becomes VERIFIED_NO_HOA", () => {
  // The listing agent's checkbox is a claim, not a title search. An HOA can
  // forbid short-term rental regardless of zoning, so a wrong "no HOA" is the
  // expensive direction.
  const l = resoToListing(rec({ AssociationYN: false }))!;
  assert.equal(l.hoaStatus, "HOA_UNKNOWN");
});

test("AssociationYN true is taken at face value — it only ever adds caution", () => {
  assert.equal(resoToListing(rec({ AssociationYN: true }))!.hoaStatus, "HOA_PRESENT");
});

// ── the fee-frequency trap ──────────────────────────────────────────────────
test("fees are converted to monthly by their stated frequency", () => {
  assert.equal(monthlyFee(1200, "Annually"), 100);
  assert.equal(monthlyFee(300, "Quarterly"), 100);
  assert.equal(monthlyFee(150, "Monthly"), 150);
  assert.equal(monthlyFee(600, "Semi-Annually"), 100);
});

test("REGRESSION: a fee with no usable frequency is null, not assumed monthly", () => {
  // $1,200 read as monthly instead of annually overstates carrying cost by
  // $13,200 a year; the reverse flatters the pro forma by the same. Both look
  // plausible on the page, which is what makes the guess dangerous.
  assert.equal(monthlyFee(1200, null), null);
  assert.equal(monthlyFee(1200, ""), null);
  assert.equal(monthlyFee(1200, "Whenever The Board Feels Like It"), null);
  assert.equal(monthlyFee(1200, "One Time"), null, "a one-time fee is not a carrying cost");
  assert.equal(monthlyFee(0, "Monthly"), null);
});

test("the fee and the HOA status agree", () => {
  const l = resoToListing(rec({ AssociationFee: 1200, AssociationFeeFrequency: "Annually" }))!;
  assert.equal(l.hoaFeeMonthly, 100);
  assert.equal(l.hoaStatus, "HOA_PRESENT", "a real fee is evidence of an HOA");
});

// ── status ──────────────────────────────────────────────────────────────────
test("statuses map to the four states the pipeline understands", () => {
  assert.equal(mapStatus("Active"), "active");
  assert.equal(mapStatus("Active Under Contract"), "pending");
  assert.equal(mapStatus("Pending"), "pending");
  assert.equal(mapStatus("Closed"), "sold");
  assert.equal(mapStatus("Withdrawn"), "removed");
  assert.equal(mapStatus("Expired"), "removed");
});

test("REGRESSION: an unrecognized status is not shown as buyable", () => {
  // Defaulting to `active` would surface a listing that may not be for sale.
  assert.equal(mapStatus("Kentucky Special"), "removed");
  assert.equal(mapStatus(null), "removed");
});

// ── numbers ─────────────────────────────────────────────────────────────────
test("bathrooms fall back to full + half when no total is published", () => {
  assert.equal(resoToListing(rec({ BathroomsTotalInteger: null, BathroomsFull: 2, BathroomsHalf: 1 }))!.baths, 2.5);
  assert.equal(resoToListing(rec({ BathroomsTotalInteger: null }))!.baths, null);
});

test("lot size converts from acres when square feet is absent", () => {
  assert.equal(resoToListing(rec({ LotSizeAcres: 0.5206 }))!.lotSqft, 22677);
  assert.equal(resoToListing(rec({ LotSizeSquareFeet: 9000, LotSizeAcres: 0.5 }))!.lotSqft, 9000,
    "the published square footage wins over a converted one");
});

test("coordinates pass through, and their absence is not fatal", () => {
  assert.equal(resoToListing(rec())!.lat, 38.012345);
  const noCoords = resoToListing(rec({ Latitude: null, Longitude: null }))!;
  assert.equal(noCoords.lat, null, "the refresh engine geocodes these rather than dropping them");
});

// ── paging ──────────────────────────────────────────────────────────────────
test("every page is followed via @odata.nextLink", async () => {
  const pages = [
    { value: [rec({ ListingKey: "a" }), rec({ ListingKey: "b" })], "@odata.nextLink": "https://x/next" },
    { value: [rec({ ListingKey: "c" })] },
  ];
  let i = 0;
  const fake = async () => ({ ok: true, json: async () => pages[i++] }) as any;
  const { rows, pages: n } = await fetchResoListings({ baseUrl: "https://x", token: "t" }, fake);
  assert.equal(rows.length, 3);
  assert.equal(n, 2);
});

test("a server that pages forever cannot hang the import", async () => {
  const fake = async () => ({ ok: true, json: async () => ({ value: [], "@odata.nextLink": "https://x/again" }) }) as any;
  const { rows } = await fetchResoListings({ baseUrl: "https://x", token: "t" }, fake);
  assert.equal(rows.length, 0, "an empty page ends the loop even with a nextLink");
});

test("REGRESSION: hitting the row ceiling is reported, not silently truncated", async () => {
  const fake = async () => ({
    ok: true,
    json: async () => ({ value: Array.from({ length: 50 }, (_, k) => rec({ ListingKey: "k" + k })), "@odata.nextLink": "https://x/n" }),
  }) as any;
  const r = await fetchResoListings({ baseUrl: "https://x", token: "t", maxRows: 100 }, fake);
  assert.equal(r.rows.length, 100);
  assert.equal(r.truncated, true, "the caller must be able to refuse a partial set");
});

test("an HTTP error carries the server's explanation", async () => {
  const fake = async () => ({ ok: false, status: 401, statusText: "Unauthorized", text: async () => "token expired" }) as any;
  await assert.rejects(
    () => fetchResoListings({ baseUrl: "https://x", token: "bad" }, fake),
    /401.*Unauthorized.*token expired/s,
  );
});

// ── the same trap on the CSV path ───────────────────────────────────────────
test("REGRESSION: a CSV fee frequency column is honoured, not ignored", async () => {
  // flexmls exports name this association_fee and commonly state it annually.
  // Mapped straight to monthly it overstates carrying cost twelvefold.
  const { parseListingRow } = await import("../src/lib/providers/listings");
  const base = { address: "1 Main St", lat: "38", lng: "-84" };
  assert.equal(parseListingRow({ ...base, association_fee: "1200", association_fee_frequency: "Annually" })!.hoaFeeMonthly, 100);
  assert.equal(parseListingRow({ ...base, hoa_fee: "150", hoa_fee_frequency: "Monthly" })!.hoaFeeMonthly, 150);
  assert.equal(parseListingRow({ ...base, hoa_fee: "150" })!.hoaFeeMonthly, 150, "no frequency column keeps the documented monthly reading");
  assert.equal(parseListingRow({ ...base, hoa_fee: "1200", hoa_fee_frequency: "Who Knows" })!.hoaFeeMonthly, null, "an unreadable cadence is not a guess");
});
