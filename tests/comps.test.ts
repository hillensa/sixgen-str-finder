import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  similarity, selectComps, weightedPercentile, assessConfidence, buildForecast,
  monthlyFromShape, COMPS_MODEL_VERSION, type CompProperty, type Subject,
} from "../src/lib/comps/engine";
import { normalizeSixgenProperties, normalizeSixgenMonthly, sixgenImportWarnings } from "../src/lib/import/sixgen";
import { parseCsv } from "../src/lib/providers/listings";

/** Shaped after the real portfolio in data/sixgen/. */
const comp = (o: Partial<CompProperty> & { id: number; name: string }): CompProperty => ({
  beds: 5, baths: 3, maxGuests: 12, adr: 800, occupancy: 0.62, grossRevenue: 180000,
  monthsWithData: 12, isPartialYear: false, ...o,
});

const POOL: CompProperty[] = [
  comp({ id: 1, name: "300 Sherman Ave", beds: 7, baths: 6.5, maxGuests: 12, hotTub: true, adr: 900, occupancy: 0.66, grossRevenue: 222000 }),
  comp({ id: 2, name: "341 Sherman Ave", beds: 5, baths: 4.5, hotTub: true, golfSim: true, gameRoom: true, adr: 820, occupancy: 0.64, grossRevenue: 191000 }),
  comp({ id: 3, name: "353 Owsley Ave", beds: 5, baths: 3.5, hotTub: true, golfSim: true, gameRoom: true, firePit: true, adr: 790, occupancy: 0.60, grossRevenue: 173000 }),
  comp({ id: 4, name: "1934 Natchez Trl", beds: 4, baths: 2.5, firePit: true, adr: 620, occupancy: 0.58, grossRevenue: 131000 }),
  comp({ id: 5, name: "617 Stratford Dr", beds: 2, baths: 1, maxGuests: 6, adr: 240, occupancy: 0.74, grossRevenue: 65000 }),
  comp({ id: 6, name: "720 W Short St", beds: 3, baths: 2.5, maxGuests: 6, hotTub: true, firePit: true, adr: 520, occupancy: 0.55, grossRevenue: 52000, monthsWithData: 3, isPartialYear: true }),
];

const subject5: Subject = { beds: 5, baths: 3.5, maxGuests: 12, hotTub: true, golfSim: true, gameRoom: true };

// ── similarity ──────────────────────────────────────────────────────────────
test("bedrooms dominate similarity — a 2BR is not a comp for a 5BR", () => {
  const same = similarity(subject5, POOL[2]).score;      // 5 bd, same amenities
  const twoBed = similarity(subject5, POOL[4]).score;    // 2 bd
  assert.ok(same > 0.9, `expected a near-perfect match, got ${same}`);
  assert.ok(twoBed < 0.45, `a 2BR should fall below the comp threshold, got ${twoBed}`);
});

test("similarity degrades with bedroom distance rather than falling off a cliff", () => {
  const s5 = similarity(subject5, comp({ id: 9, name: "x", beds: 5 })).score;
  const s4 = similarity(subject5, comp({ id: 9, name: "x", beds: 4 })).score;
  const s3 = similarity(subject5, comp({ id: 9, name: "x", beds: 3 })).score;
  const s1 = similarity(subject5, comp({ id: 9, name: "x", beds: 1 })).score;
  assert.ok(s5 > s4 && s4 > s3 && s3 > s1);
  assert.equal(similarity(subject5, comp({ id: 9, name: "x", beds: 5 })).reasons[0], "5 bd exact match");
});

test("shared amenities raise the match and are named", () => {
  const withAmenities = similarity(subject5, POOL[1]);
  assert.ok(withAmenities.reasons.some((r) => /hot tub/.test(r)));
  const bare = similarity(subject5, comp({ id: 9, name: "x", beds: 5 })).score;
  assert.ok(withAmenities.score > bare);
});

test("unknown capacity is neutral, not disqualifying", () => {
  const known = similarity({ beds: 5 }, comp({ id: 9, name: "x", beds: 5, maxGuests: 12 })).score;
  assert.ok(known > 0.5, "a subject with no stated capacity still comps");
});

// ── selection and weighting ─────────────────────────────────────────────────
test("comps below the similarity floor are excluded entirely", () => {
  const picked = selectComps(subject5, POOL);
  assert.ok(!picked.some((c) => c.comp.name === "617 Stratford Dr"), "the 2BR mid-term listing must not comp a 5BR STR");
});

test("weights normalize to 1 across the selected set", () => {
  const picked = selectComps(subject5, POOL);
  const total = picked.reduce((s, c) => s + c.weight, 0);
  assert.ok(Math.abs(total - 1) < 0.01, `weights summed to ${total}`);
});

test("a part-year listing is downweighted, not dropped and not averaged in whole", () => {
  const partial = comp({ id: 20, name: "New listing", beds: 5, monthsWithData: 3, isPartialYear: true });
  const full = comp({ id: 21, name: "Established", beds: 5, monthsWithData: 12 });
  const picked = selectComps(subject5, [partial, full]);
  const p = picked.find((c) => c.comp.id === 20)!;
  const f = picked.find((c) => c.comp.id === 21)!;
  assert.ok(p.weight < f.weight, "three months of history cannot carry the same weight as twelve");
  assert.ok(p.weight > 0, "but it is still evidence");
  assert.ok(p.reasons.some((r) => /3 of 12 months/.test(r)));
});

test("a comp with no trailing revenue is excluded rather than counted at zero", () => {
  const empty = comp({ id: 30, name: "Never booked", adr: null, occupancy: null, monthsWithData: 0 });
  const picked = selectComps(subject5, [...POOL, empty]);
  assert.ok(!picked.some((c) => c.comp.id === 30));
});

test("weighted percentiles bracket the weighted mean", () => {
  const picked = selectComps(subject5, POOL);
  const p25 = weightedPercentile(picked, (c) => c.adr, 0.25);
  const p75 = weightedPercentile(picked, (c) => c.adr, 0.75);
  assert.ok(p25 <= p75);
  assert.equal(weightedPercentile([], (c) => c.adr, 0.5), 0, "an empty set yields 0, not NaN");
});

// ── confidence ──────────────────────────────────────────────────────────────
test("confidence reflects comp count, closeness and year coverage", () => {
  const good = assessConfidence(selectComps(subject5, POOL), subject5);
  assert.equal(good.confidence, "HIGH");

  const thin = assessConfidence(selectComps(subject5, [POOL[1]]), subject5);
  assert.equal(thin.confidence, "LOW");
  assert.ok(thin.reasons.some((r) => /Only 1 comparable/.test(r)));

  const none = assessConfidence([], subject5);
  assert.equal(none.confidence, "LOW");
  assert.equal(none.coverage, 0);
});

test("no exact bedroom match is called out", () => {
  const s: Subject = { beds: 6, maxGuests: 12 };
  const a = assessConfidence(selectComps(s, POOL), s);
  assert.ok(a.reasons.some((r) => /same bedroom count/.test(r)));
  assert.notEqual(a.confidence, "HIGH");
});

// ── the forecast ────────────────────────────────────────────────────────────
test("a forecast produces ordered scenarios and states its basis", () => {
  const f = buildForecast(subject5, POOL, { occupancyCap: 0.82 });
  assert.equal(f.modelVersion, COMPS_MODEL_VERSION);
  assert.ok(f.compCount >= 3);
  assert.ok(f.scenarios.conservative.revenue <= f.scenarios.base.revenue);
  assert.ok(f.scenarios.base.revenue <= f.scenarios.upside.revenue);
  assert.ok(f.adr > 0 && f.occupancy > 0);
  assert.ok(f.notes.some((n) => /floor/.test(n)), "the occupancy caveat must always be stated");
});

test("REGRESSION: a high base occupancy cannot invert the scenario ordering", () => {
  // 0.95 + 0.07 = 1.02 used to be re-read as 1.02% — the upside collapsed below
  // the conservative case. Single comp forces the ±spread fallback path.
  const hot = comp({ id: 40, name: "Always full", beds: 5, adr: 800, occupancy: 0.95 });
  const f = buildForecast(subject5, [hot], { occupancyCap: 1 });
  assert.ok(f.scenarios.upside.occupancy >= f.scenarios.base.occupancy, "upside occupancy must not fall");
  assert.ok(f.scenarios.upside.revenue > f.scenarios.conservative.revenue);
  assert.ok(f.scenarios.upside.occupancy <= 1, "and must stay a fraction");
});

test("the occupancy ceiling is applied and disclosed", () => {
  const hot = comp({ id: 41, name: "Always full", beds: 5, adr: 800, occupancy: 0.95, monthsWithData: 12 });
  const f = buildForecast(subject5, [hot, comp({ id: 42, name: "Also full", beds: 5, adr: 820, occupancy: 0.93 })], { occupancyCap: 0.82 });
  assert.ok(f.occupancy <= 0.82);
  assert.ok(f.notes.some((n) => /capped at the 82%/.test(n)));
});

test("no usable comp yields an explicit refusal, not a zero forecast presented as fact", () => {
  const f = buildForecast({ beds: 12 }, POOL);
  assert.equal(f.compCount, 0);
  assert.equal(f.confidence, "LOW");
  assert.equal(f.annualRevenue, 0);
  assert.match(f.notes[0], /No forecast produced/);
});

test("a single comp uses a documented spread and says so", () => {
  const f = buildForecast(subject5, [POOL[2]]);
  assert.equal(f.compCount, 1);
  assert.ok(f.notes.some((n) => /documented .13% spread/.test(n)));
});

test("gross yield is computed only when a price is supplied", () => {
  assert.equal(buildForecast(subject5, POOL).grossYieldPct, null);
  const withPrice = buildForecast({ ...subject5, price: 750000 }, POOL);
  assert.ok(withPrice.grossYieldPct! > 0);
});

// ── monthly shape ───────────────────────────────────────────────────────────
test("monthly revenue reconciles exactly to the annual total", () => {
  const shape = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, adrIndex: [0.73, 0.75, 0.86, 1.0, 0.93, 0.96, 0.99, 0.98, 0.96, 1.02, 0.85, 0.75][i] }));
  const rows = monthlyFromShape(187428, 790, shape)!;
  assert.equal(rows.length, 12);
  assert.equal(rows.reduce((a, r) => a + r.revenue, 0), 187428);
  assert.ok(rows[3].revenue > rows[0].revenue, "April (Keeneland) beats January");
  assert.ok(rows.every((r) => r.occupancy <= 1), "a derived occupancy can never exceed 1");
});

test("an incomplete seasonality shape yields no monthly curve rather than a wrong one", () => {
  assert.equal(monthlyFromShape(100000, 700, [{ month: 1, adrIndex: 1 }]), null);
  assert.equal(monthlyFromShape(100000, 700, Array.from({ length: 12 }, (_, i) => ({ month: i + 1, adrIndex: 0 }))), null);
});

// ── the Sixgen import, against the real file shape ──────────────────────────
test("the real properties export normalizes, amenity flags and all", () => {
  const csv = readFileSync(join(__dirname, "..", "data", "sixgen", "sixgen_properties.csv"), "utf8");
  const { rows, errors } = normalizeSixgenProperties(parseCsv(csv));
  assert.equal(rows.length, 17, "17 Lexington listings");
  assert.deepEqual(errors, []);

  const sherman = rows.find((r) => r.name === "300 Sherman Ave")!;
  assert.equal(sherman.beds, 7);
  assert.equal(sherman.baths, 6.5);
  assert.equal(sherman.maxGuests, 12);
  assert.equal(sherman.hotTub, true);
  assert.equal(sherman.golfSim, false);
  assert.equal(sherman.zip, "40502");
  assert.ok(sherman.guestyId);
  assert.ok(sherman.amenities.includes("Hot Tub"));

  const lamar = rows.find((r) => r.name === "3141 Lamar Dr")!;
  assert.equal(lamar.pool, true, "the one listing with a real pool");
});

test("the real monthly export normalizes, and zero-booking months stay zero", () => {
  const csv = readFileSync(join(__dirname, "..", "data", "sixgen", "sixgen_monthly_performance.csv"), "utf8");
  const { rows, errors } = normalizeSixgenMonthly(parseCsv(csv));
  assert.equal(rows.length, 408, "17 listings x 24 months");
  assert.deepEqual(errors, []);

  const first = rows[0];
  assert.equal(first.year, 2024);
  assert.equal(first.month, 9);
  assert.equal(first.occupiedNights, 21);
  assert.ok(Math.abs(first.occupancy! - 0.7) < 0.001);

  const shortSt = rows.filter((r) => r.name === "720 W Short St" && r.year === 2024);
  assert.ok(shortSt.length > 0);
  assert.ok(shortSt.every((r) => (r.occupiedNights ?? 0) === 0), "pre-launch months are zero in the source");
  assert.ok(shortSt.every((r) => r.adr == null), "and carry no invented ADR");
});

test("import warnings name the pre-launch problem explicitly", () => {
  const props = normalizeSixgenProperties(parseCsv(readFileSync(join(__dirname, "..", "data", "sixgen", "sixgen_properties.csv"), "utf8"))).rows;
  const monthly = normalizeSixgenMonthly(parseCsv(readFileSync(join(__dirname, "..", "data", "sixgen", "sixgen_monthly_performance.csv"), "utf8"))).rows;
  const w = sixgenImportWarnings(props, monthly);
  assert.ok(w.some((x) => /not vacancy/.test(x)), "an operator must be told zeros are not always vacancy");
});

test("a listing with no bedroom count is flagged as unusable as a comparable", () => {
  const { rows } = normalizeSixgenProperties([{ name: "Mystery House", guesty_id: "abc" }]);
  assert.equal(rows[0].beds, null);
  assert.ok(rows[0].errors[0].includes("cannot be used as a comparable"));
  assert.ok(sixgenImportWarnings(rows, []).some((w) => /no bedroom count/.test(w)));
});

// ── migration guards ────────────────────────────────────────────────────────
const sql = readFileSync(join(__dirname, "..", "supabase", "migrations", "0006_phase5.sql"), "utf8");

test("REGRESSION: append-only history cannot silently double on re-import", () => {
  // unique (…, import_id) was useless while import_id was nullable, because
  // NULLs are distinct in a unique constraint
  assert.ok(/alter column import_id set not null/.test(sql));
  assert.ok(/v_sixgen_monthly_current/.test(sql), "and comps read only the newest reading per month");
});

test("REGRESSION: comps are built on trailing twelve, never the full 24-month window", () => {
  assert.ok(/fn_sixgen_t12/.test(sql));
  assert.ok(/months_with_data/.test(sql), "part-year listings must be identifiable");
  assert.ok(/is_partial_year/.test(sql));
});
