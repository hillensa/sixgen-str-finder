import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { diffListings, isPricePoint, needsRescreen, summarizeDiff, type ExistingListing } from "../src/lib/listings/diff";
import { parseListingFilters, describeFilters, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "../src/lib/listings/query";
import { normalizeRow, parseCsv } from "../src/lib/providers/listings";
import type { NormalizedListing } from "../src/lib/providers/listings";

const incoming = (o: Partial<NormalizedListing> & { externalId: string }): NormalizedListing => ({
  address: "697 Cindy Blair Way", addressNorm: "697 CINDY BLAIR WAY", unit: null, zip: "40503",
  lat: 37.9969, lng: -84.5563, price: 649900, beds: 4, hoaStatus: "HOA_UNKNOWN", status: "active",
  ...o,
} as NormalizedListing);

const stored = (o: Partial<ExistingListing> & { id: number; externalId: string }): ExistingListing => ({
  propertyId: 100 + o.id, status: "active", listPrice: 649900, originalPrice: 649900, removedAt: null, ...o,
});

test("a listing the provider has not sent before is new", () => {
  const d = diffListings([], [incoming({ externalId: "A" })]);
  assert.equal(d.counts.new, 1);
  assert.match(d.changes[0].reason, /New listing at \$649,900/);
});

test("a price cut is reported with its direction, size and percentage", () => {
  const d = diffListings([stored({ id: 1, externalId: "A" })], [incoming({ externalId: "A", price: 599900 })]);
  const c = d.changes[0];
  assert.equal(c.kind, "price_change");
  assert.equal(c.priceDelta, -50000);
  assert.equal(c.pricePct, -7.7);
  assert.match(c.reason, /Cut from \$649,900 to \$599,900/);
});

test("a price rise is not described as a cut", () => {
  const d = diffListings([stored({ id: 1, externalId: "A" })], [incoming({ externalId: "A", price: 699900 })]);
  assert.match(d.changes[0].reason, /Raised from/);
  assert.ok(d.changes[0].priceDelta! > 0);
});

test("an unchanged listing is reported, not silently dropped", () => {
  const d = diffListings([stored({ id: 1, externalId: "A" })], [incoming({ externalId: "A" })]);
  assert.equal(d.counts.unchanged, 1);
  assert.equal(d.changes.length, 1, "every incoming row gets an outcome");
});

test("a status move with no price move is its own outcome", () => {
  const d = diffListings([stored({ id: 1, externalId: "A" })], [incoming({ externalId: "A", status: "pending" })]);
  assert.equal(d.changes[0].kind, "status_change");
  assert.match(d.changes[0].reason, /active to pending/);
});

test("a previously removed listing coming back is relisted, not new", () => {
  const d = diffListings(
    [stored({ id: 1, externalId: "A", status: "removed", removedAt: "2026-01-01T00:00:00Z", listPrice: 700000 })],
    [incoming({ externalId: "A", price: 649900 })]);
  assert.equal(d.counts.relisted, 1);
  assert.equal(d.counts.new, 0);
  assert.match(d.changes[0].reason, /Back on the market at \$649,900/);
});

// ── the removal default that made a partial paste destructive ───────────────
test("a partial refresh never marks anything removed", () => {
  const d = diffListings(
    [stored({ id: 1, externalId: "A" }), stored({ id: 2, externalId: "B" }), stored({ id: 3, externalId: "C" })],
    [incoming({ externalId: "A" })]);
  assert.equal(d.counts.removed, 0, "B and C were simply not mentioned");
  assert.match(summarizeDiff(d, false), /removals not evaluated/);
});

test("a full refresh marks the absent listings removed, with the reason", () => {
  const d = diffListings(
    [stored({ id: 1, externalId: "A" }), stored({ id: 2, externalId: "B" })],
    [incoming({ externalId: "A" })], { fullSync: true });
  assert.equal(d.counts.removed, 1);
  const r = d.changes.find((c) => c.kind === "removed")!;
  assert.equal(r.externalId, "B");
  assert.match(r.reason, /Absent from a full refresh/);
});

test("a full refresh does not re-remove what is already gone or sold", () => {
  const d = diffListings(
    [stored({ id: 1, externalId: "A", status: "removed", removedAt: "2026-01-01T00:00:00Z" }),
     stored({ id: 2, externalId: "B", status: "sold" })],
    [], { fullSync: true });
  assert.equal(d.counts.removed, 0);
});

test("duplicate external ids inside one payload are counted, not written twice", () => {
  const d = diffListings([], [incoming({ externalId: "A" }), incoming({ externalId: "A", price: 1 })]);
  assert.equal(d.counts.new, 1);
  assert.equal(d.duplicatesInPayload, 1);
});

test("only new and relisted rows trigger a re-screen", () => {
  const d = diffListings(
    [stored({ id: 1, externalId: "A" }), stored({ id: 2, externalId: "B", status: "removed", removedAt: "2026-01-01T00:00:00Z" })],
    [incoming({ externalId: "A", price: 500000 }), incoming({ externalId: "B" }), incoming({ externalId: "C" })]);
  // a price move does not change the 600-ft answer
  assert.deepEqual(needsRescreen(d.changes).map((c) => c.kind).sort(), ["new", "relisted"]);
});

test("price history is written for a new, a change, and a relist with a move — not for an unchanged row", () => {
  const d = diffListings(
    [stored({ id: 1, externalId: "A" }), stored({ id: 2, externalId: "B" })],
    [incoming({ externalId: "A" }), incoming({ externalId: "B", price: 600000 }), incoming({ externalId: "C" })]);
  const byId = Object.fromEntries(d.changes.map((c) => [c.externalId, c]));
  assert.equal(isPricePoint(byId.A), false, "unchanged");
  assert.equal(isPricePoint(byId.B), true, "price change");
  assert.equal(isPricePoint(byId.C), true, "new");
});

// ── the HOA normalization that asserted verification it did not have ────────
test("an unrecognized HOA value is HOA_UNKNOWN, never VERIFIED_NO_HOA", () => {
  for (const v of ["unknown", "N/A", "-", "tbd", "?"]) {
    const row = { address: "697 Cindy Blair Way", lat: "37.9969", lng: "-84.5563", hoa: v };
    assert.equal(normalizeRow(row)!.hoaStatus, "HOA_UNKNOWN", v);
  }
});

test("a bare 'false' from a provider is still unverified", () => {
  const row = { address: "697 Cindy Blair Way", lat: "37.9969", lng: "-84.5563", hoa: "false" };
  assert.equal(normalizeRow(row)!.hoaStatus, "HOA_UNKNOWN", "a claim is not a verification");
});

test("an explicit hoa_verified column is what unlocks VERIFIED_NO_HOA", () => {
  const row = { address: "697 Cindy Blair Way", lat: "37.9969", lng: "-84.5563", hoa: "false", hoa_verified: "true" };
  assert.equal(normalizeRow(row)!.hoaStatus, "VERIFIED_NO_HOA");
});

test("a positive HOA fee still means HOA_PRESENT without any verification", () => {
  const row = { address: "697 Cindy Blair Way", lat: "37.9969", lng: "-84.5563", hoa_fee: "250" };
  assert.equal(normalizeRow(row)!.hoaStatus, "HOA_PRESENT");
  const zero = { address: "697 Cindy Blair Way", lat: "37.9969", lng: "-84.5563", hoa_fee: "0" };
  assert.equal(normalizeRow(zero)!.hoaStatus, "HOA_UNKNOWN", "$0 is not proof of no HOA");
});

test("a normalized row carries the canonical address used to match one property", () => {
  const rows = parseCsv("address,lat,lng,price,beds\n\"697 Cindy Blair Way, Lexington, KY 40503\",37.9969,-84.5563,649900,4\n");
  const l = normalizeRow(rows[0])!;
  assert.equal(l.addressNorm, "697 CINDY BLAIR WAY");
  assert.equal(l.zip, "40503");
});

// ── the optional filter set ─────────────────────────────────────────────────
test("filters parse from a query string with sane bounds", () => {
  const f = parseListingFilters(new URLSearchParams("minPrice=400000&minBeds=4&classification=GREEN,YELLOW&sort=price_drop&pageSize=500"));
  assert.equal(f.minPrice, 400000);
  assert.equal(f.minBeds, 4);
  assert.deepEqual(f.classification, ["GREEN", "YELLOW"]);
  assert.equal(f.sort, "price_drop");
  assert.equal(f.pageSize, MAX_PAGE_SIZE, "page size is capped");
});

test("an absent filter narrows nothing", () => {
  const f = parseListingFilters(new URLSearchParams(""));
  assert.equal(f.minPrice, null);
  assert.deepEqual(f.status, []);
  assert.deepEqual(f.classification, []);
  assert.equal(f.pageSize, DEFAULT_PAGE_SIZE);
  assert.equal(f.sort, "newest");
  assert.deepEqual(describeFilters(f), [], "nothing to disclose when nothing is filtered");
});

test("junk values are dropped rather than passed to the database", () => {
  const f = parseListingFilters(new URLSearchParams("status=active,bogus&classification=PURPLE&sort=drop_table&zip=40503,abc&hoa=NOPE"));
  assert.deepEqual(f.status, ["active"]);
  assert.deepEqual(f.classification, []);
  assert.deepEqual(f.zips, ["40503"]);
  assert.deepEqual(f.hoaStatus, []);
  assert.equal(f.sort, "newest", "an unknown sort falls back rather than reaching the query");
});

test("an inverted range is swapped instead of returning nothing", () => {
  const f = parseListingFilters(new URLSearchParams("minPrice=900000&maxPrice=400000&minSqft=4000&maxSqft=1000"));
  assert.equal(f.minPrice, 400000);
  assert.equal(f.maxPrice, 900000);
  assert.equal(f.minSqft, 1000);
  assert.equal(f.maxSqft, 4000);
});

test("active filters are described so the UI can say what is hidden", () => {
  const f = parseListingFilters(new URLSearchParams("minPrice=400000&minBeds=4&priceDrop=1&pool=1&q=Cindy"));
  const d = describeFilters(f);
  assert.ok(d.includes("$400,000+"));
  assert.ok(d.includes("4+ bd"));
  assert.ok(d.includes("price reduced"));
  assert.ok(d.includes("pool"));
});

// ── regression guards ───────────────────────────────────────────────────────
test("REGRESSION: properties have an identity, and the refresh looks one up before inserting", () => {
  const sql = readFileSync(join(__dirname, "..", "supabase", "migrations", "0005_phase4.sql"), "utf8");
  assert.ok(/create unique index if not exists properties_identity_uniq/.test(sql));
  assert.ok(/fn_match_property/.test(sql));
  const engine = readFileSync(join(__dirname, "..", "src/lib/listings/refresh.ts"), "utf8");
  assert.ok(/rpc\("fn_match_property"/.test(engine), "a listing must find its property before creating one");
});

test("REGRESSION: full sync is opt-in at every entry point", () => {
  for (const p of ["src/app/api/listings/refresh/route.ts", "src/app/api/listings/import/route.ts"]) {
    const src = readFileSync(join(__dirname, "..", p), "utf8");
    assert.ok(/fullSync: body\.fullSync === true/.test(src), `${p} must require an explicit opt-in`);
    assert.ok(!/body\.full !== false/.test(src), `${p} must not default full sync on`);
  }
});

test("REGRESSION: both import entry points share one engine", () => {
  for (const p of ["src/app/api/listings/refresh/route.ts", "src/app/api/listings/import/route.ts"]) {
    assert.ok(/runRefresh/.test(readFileSync(join(__dirname, "..", p), "utf8")), `${p} must delegate to the shared engine`);
  }
});
