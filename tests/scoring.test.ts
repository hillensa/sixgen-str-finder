import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scoreCandidates, gateReason, factorLabel, SCORING_MODEL_VERSION, type Candidate, type Weight } from "../src/lib/scoring/score";
import { computeProForma, annualDebtService, amenityScenarios, assumptionsFrom, DEFAULT_ASSUMPTIONS, type ProFormaAssumptions } from "../src/lib/proforma";

const WEIGHTS: Weight[] = [
  { factorKey: "revenue_yield", factorName: "Revenue yield", weight: 0.30 },
  { factorKey: "absolute_revenue", factorName: "Absolute revenue", weight: 0.20 },
  { factorKey: "comp_strength", factorName: "Comp strength", weight: 0.15 },
  { factorKey: "guest_capacity", factorName: "Guest capacity", weight: 0.10 },
  { factorKey: "bedroom_opportunity", factorName: "Bedroom opportunity", weight: 0.10 },
  { factorKey: "price_efficiency", factorName: "Price efficiency", weight: 0.05 },
  { factorKey: "amenity_potential", factorName: "Amenity potential", weight: 0.05 },
  { factorKey: "location_demand", factorName: "Location demand", weight: 0.05 },
];

const cand = (o: Partial<Candidate> & { propertyId: number }): Candidate => ({
  address: `Property ${o.propertyId}`, listPrice: 600000, beds: 5, baths: 3, sqft: 3000,
  lotSqft: 8000, basement: true, finishedBasement: false, pool: false, garage: true,
  lat: 38.03, lng: -84.50, hoaStatus: "VERIFIED_NO_HOA", classification: "GREEN",
  eligibilitySummary: null, forecastRevenue: 150000, forecastConfidence: "HIGH",
  compCount: 5, compCoverage: 1, status: "active", ...o,
});

// ── the gate ────────────────────────────────────────────────────────────────
test("a RED property is gated out with its reason, never ranked low", () => {
  const red = cand({ propertyId: 1, classification: "RED", eligibilitySummary: "An existing blocking STR is 412 ft away." });
  const r = scoreCandidates([red, cand({ propertyId: 2 })], WEIGHTS);
  assert.equal(r.ranked.length, 1);
  assert.equal(r.gated.length, 1);
  assert.equal(r.gated[0].score, null, "a gated property gets no score at all");
  assert.match(r.gated[0].gateReason!, /412 ft/);
});

test("a YELLOW property is ranked but listed for review — unknown is not failure", () => {
  const yellow = cand({ propertyId: 1, classification: "YELLOW", eligibilitySummary: "HOA unverified." });
  const r = scoreCandidates([yellow, cand({ propertyId: 2 })], WEIGHTS);
  assert.equal(r.gated.length, 0);
  assert.equal(r.ranked.length, 2);
  assert.equal(r.requiresReview.length, 1);
});

test("an unverified HOA ranks but appears on the HOA list", () => {
  const r = scoreCandidates([cand({ propertyId: 1, hoaStatus: "HOA_UNKNOWN" }), cand({ propertyId: 2 })], WEIGHTS);
  assert.equal(r.ranked.length, 2);
  assert.equal(r.needsHoaVerification.length, 1);
  assert.equal(r.needsHoaVerification[0].candidate.propertyId, 1);
});

test("missing price, missing forecast and inactive status all gate with a plain reason", () => {
  assert.match(gateReason(cand({ propertyId: 1, listPrice: null }))!, /No list price/);
  assert.match(gateReason(cand({ propertyId: 1, forecastRevenue: null }))!, /No revenue forecast/);
  assert.match(gateReason(cand({ propertyId: 1, status: "pending" }))!, /is pending, not active/);
  assert.equal(gateReason(cand({ propertyId: 1 })), null);
});

// ── factors and weighting ───────────────────────────────────────────────────
test("a better yield outranks a worse one, all else equal", () => {
  const cheap = cand({ propertyId: 1, listPrice: 400000, forecastRevenue: 150000 });   // 37.5%
  const dear = cand({ propertyId: 2, listPrice: 900000, forecastRevenue: 150000 });    // 16.7%
  const r = scoreCandidates([dear, cheap], WEIGHTS);
  assert.equal(r.ranked[0].candidate.propertyId, 1);
  assert.equal(r.ranked[0].rank, 1);
  assert.ok(r.ranked[0].score! > r.ranked[1].score!);
});

test("scores stay within 0..100 and every factor is explained", () => {
  const r = scoreCandidates([cand({ propertyId: 1 }), cand({ propertyId: 2, listPrice: 900000 })], WEIGHTS);
  for (const s of r.ranked) {
    assert.ok(s.score! >= 0 && s.score! <= 100, `score out of range: ${s.score}`);
    for (const key of WEIGHTS.map((w) => w.factorKey)) {
      assert.ok(key in s.breakdown, `${key} missing from the breakdown`);
    }
  }
});

test("a missing input redistributes its weight rather than scoring zero", () => {
  // no sqft ⇒ price_efficiency and bedroom_opportunity cannot be computed
  const noSqft = cand({ propertyId: 1, sqft: null });
  const r = scoreCandidates([noSqft, cand({ propertyId: 2 })], WEIGHTS);
  const s = r.ranked.find((x) => x.candidate.propertyId === 1)!;
  assert.ok(s.unavailableFactors.includes("price_efficiency"));
  assert.equal(s.breakdown.price_efficiency.normalized, null);
  assert.equal(s.breakdown.price_efficiency.points, 0);
  assert.match(s.breakdown.price_efficiency.note!, /redistributed/);

  const available = Object.values(s.breakdown).filter((b) => b.normalized != null);
  const total = available.reduce((sum, b) => sum + b.weight, 0);
  assert.ok(Math.abs(total - 1) < 0.01, `remaining weights should still sum to 1, got ${total}`);
});

test("a factor unavailable for the whole pool says so, and does not punish anyone", () => {
  // no demand points loaded ⇒ location_demand is unavailable everywhere
  const r = scoreCandidates([cand({ propertyId: 1 }), cand({ propertyId: 2 })], WEIGHTS, { demand: [] });
  const s = r.ranked[0];
  assert.equal(s.breakdown.location_demand.normalized, null);
  assert.match(s.breakdown.location_demand.note!, /any candidate/);
});

test("location demand favours proximity to Sixgen's producing listings", () => {
  const demand = [{ lat: 38.033, lng: -84.471, t12Revenue: 220000, name: "300 Sherman Ave" }];
  const near = cand({ propertyId: 1, lat: 38.034, lng: -84.472 });
  const far = cand({ propertyId: 2, lat: 38.20, lng: -84.90 });
  const r = scoreCandidates([far, near], WEIGHTS, { demand });
  const n = r.ranked.find((x) => x.candidate.propertyId === 1)!;
  const f = r.ranked.find((x) => x.candidate.propertyId === 2)!;
  assert.ok(n.breakdown.location_demand.normalized! > f.breakdown.location_demand.normalized!);
});

test("a single candidate does not divide by zero when there is no spread", () => {
  const r = scoreCandidates([cand({ propertyId: 1 })], WEIGHTS);
  assert.equal(r.ranked.length, 1);
  assert.ok(Number.isFinite(r.ranked[0].score!));
  assert.equal(r.ranked[0].breakdown.revenue_yield.normalized, 0.5, "no spread means average, not best");
});

test("an empty pool and unknown factor keys are handled without throwing", () => {
  assert.deepEqual(scoreCandidates([], WEIGHTS).ranked, []);
  const r = scoreCandidates([cand({ propertyId: 1 })], [{ factorKey: "not_a_factor", factorName: "?", weight: 1 }]);
  assert.equal(r.weightsUsed.length, 0);
  assert.equal(r.ranked[0].score, 0);
});

test("the model version is recorded", () => {
  assert.equal(scoreCandidates([cand({ propertyId: 1 })], WEIGHTS).modelVersion, SCORING_MODEL_VERSION);
  assert.equal(factorLabel("revenue_yield"), "Revenue yield");
});

// ── pro forma ───────────────────────────────────────────────────────────────
const A: ProFormaAssumptions = {
  ...DEFAULT_ASSUMPTIONS,
  purchasePrice: 700000, annualRevenue: 160000, beds: 5, occupancy: 0.65,
};

test("a mortgage payment matches the standard amortization formula", () => {
  // $525,000 at 7% over 30 years ≈ $3,493/mo ≈ $41,917/yr
  const annual = annualDebtService(525000, 7, 30);
  assert.ok(Math.abs(annual - 41917) < 200, `got ${annual}`);
  assert.equal(annualDebtService(0, 7, 30), 0);
  assert.equal(annualDebtService(100000, 0, 10), 10000, "a zero-rate loan is straight-line");
});

test("NOI, cap rate and cash-on-cash reconcile with the expense lines", () => {
  const r = computeProForma(A);
  assert.equal(r.noi, r.revenue - r.totalExpenses);
  assert.equal(r.totalExpenses, r.expenses.reduce((s, e) => s + e.annual, 0));
  assert.equal(r.capRatePct, +((r.noi / A.purchasePrice) * 100).toFixed(2));
  assert.equal(r.cashFlow, r.noi - r.annualDebtService);
  assert.ok(r.cashInvested > 0);
  assert.equal(r.cashOnCashPct, +((r.cashFlow / r.cashInvested) * 100).toFixed(2));
});

test("every expense line states its basis", () => {
  for (const e of computeProForma(A).expenses) {
    assert.ok(e.basis && e.basis.length > 0, `${e.key} has no stated basis`);
  }
});

test("an unfinanced purchase has no debt service and all cash invested", () => {
  const r = computeProForma({ ...A, financed: false });
  assert.equal(r.annualDebtService, 0);
  assert.equal(r.dscr, null);
  assert.equal(r.cashFlow, r.noi);
  assert.ok(r.cashInvested >= A.purchasePrice);
});

test("thin coverage and negative NOI are warned about, not hidden", () => {
  const thin = computeProForma({ ...A, annualRevenue: 60000 });
  assert.ok(thin.warnings.length > 0);
  const negative = computeProForma({ ...A, annualRevenue: 20000 });
  assert.ok(negative.noi < 0);
  assert.ok(negative.warnings.some((w) => /exceed forecast revenue/.test(w)));
});

test("break-even occupancy is null when a night loses money, rather than a wrong number", () => {
  const bad = computeProForma({ ...A, annualRevenue: 8000, occupancy: 0.6, cleaningPerStay: 900 });
  assert.equal(bad.breakEvenOccupancy, null);
  assert.ok(bad.warnings.some((w) => /no break-even occupancy/.test(w)));

  const ok = computeProForma(A);
  assert.ok(ok.breakEvenOccupancy! > 0 && ok.breakEvenOccupancy! <= 1);
});

test("an occupancy assumption above the app's own ceiling is flagged", () => {
  assert.ok(computeProForma({ ...A, occupancy: 0.92 }).warnings.some((w) => /occupancy assumption is above/.test(w)));
});

test("amenity scenarios are sorted by payback and only pay back when NOI rises", () => {
  const scenarios = amenityScenarios(A);
  assert.ok(scenarios.length >= 4);
  const paybacks = scenarios.map((s) => s.paybackYears ?? Infinity);
  assert.deepEqual(paybacks, [...paybacks].sort((a, b) => a - b), "must be ordered by payback");
  for (const s of scenarios) {
    assert.ok(s.addedRevenue > 0);
    assert.ok(s.newRevenue > A.annualRevenue);
    if (s.paybackYears != null) assert.ok(s.paybackYears > 0);
  }
});

test("stored defaults win over the built-in ones", () => {
  const a = assumptionsFrom({ management_pct: 0.15, insurance_annual: 5000 }, { purchasePrice: 500000, annualRevenue: 120000, beds: 4, occupancy: 0.6 });
  assert.equal(a.managementPct, 0.15);
  assert.equal(a.insuranceAnnual, 5000);
  assert.equal(a.repairsPct, DEFAULT_ASSUMPTIONS.repairsPct, "unspecified keys fall back");
  assert.equal(a.purchasePrice, 500000);
});

test("a property's own HOA fee overrides the default", () => {
  const a = assumptionsFrom({ hoa_monthly: 0 }, { purchasePrice: 500000, annualRevenue: 120000, beds: 4, occupancy: 0.6, hoaMonthly: 240 });
  assert.equal(a.hoaMonthly, 240);
  assert.ok(computeProForma(a).expenses.some((e) => e.key === "hoa"));
});

// ── migration guards ────────────────────────────────────────────────────────
const sql = readFileSync(join(__dirname, "..", "supabase", "migrations", "0007_phase6.sql"), "utf8");

test("REGRESSION: the ranked view excludes gated properties", () => {
  assert.ok(/create view v_top_candidates/.test(sql));
  assert.ok(/where not s\.gated/.test(sql), "a gated property must never surface in the ranking");
});

test("REGRESSION: pipeline statuses and pro forma defaults are configuration, not code", () => {
  assert.ok(/'pipeline_statuses'/.test(sql));
  assert.ok(/'proforma_defaults'/.test(sql));
});

test("REGRESSION: every score keeps the weights it was computed under", () => {
  const route = readFileSync(join(__dirname, "..", "src/app/api/scores/route.ts"), "utf8");
  assert.ok(/weights_snapshot: result\.weightsUsed/.test(route),
    "a ranking must remain explainable after the weights change");
  assert.ok(/gate_reason/.test(route));
});
