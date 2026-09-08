import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyEligibility, cupRequiredFor, factsFromRow, factLabel, type EligibilityFacts } from "../src/lib/eligibility";

/** A property that passes everything this tool can check. */
const CLEAN: EligibilityFacts = {
  zoneCode: "B-1",
  zoningTreatment: "principal_use",
  spacingResult: "PASS",
  spacingFt: 600,
  nearestPermitId: null,
  nearestAddress: null,
  nearestDistanceFt: null,
  spacingMeasured: "parcel_edge",
  densityResult: "NOT_CONFIGURED",
  densityRadiusFt: null,
  densityThresholdPct: null,
  densityStrs: null,
  densityUnits: null,
  densityPct: null,
  densityPctAfter: null,
  hoaStatus: "VERIFIED_NO_HOA",
  subjectSource: "parcel",
  parcelMatchConfidence: 0.95,
};
const facts = (o: Partial<EligibilityFacts> = {}): EligibilityFacts => ({ ...CLEAN, ...o });
const codes = (f: EligibilityFacts) => classifyEligibility(f).failures.map((x) => x.code).sort();

test("GREEN requires every check to pass on evidence", () => {
  const r = classifyEligibility(CLEAN);
  assert.equal(r.classification, "GREEN");
  assert.deepEqual(r.failures, []);
  assert.equal(r.cupRequired, "NOT_REQUIRED");
  assert.match(r.summary, /Confirm with LFUCG/);
});

// ── RED: a rule this tool can evaluate says no ──────────────────────────────
test("a separation failure is RED and names the permit that caused it", () => {
  const r = classifyEligibility(facts({
    spacingResult: "FAIL", nearestDistanceFt: 412, nearestPermitId: 88, nearestAddress: "300 SHERMAN AVE",
  }));
  assert.equal(r.classification, "RED");
  const f = r.failures.find((x) => x.code === "SPACING_FAIL")!;
  assert.equal(f.severity, "fail");
  assert.match(f.message, /412 ft/);
  assert.match(f.message, /600-ft/);
  assert.equal(f.evidence?.permitId, 88, "the blocking permit is recorded, not just the verdict");
  assert.equal(f.evidence?.address, "300 SHERMAN AVE");
});

test("prohibited zoning, a present HOA, and a density failure are each RED", () => {
  assert.equal(classifyEligibility(facts({ zoningTreatment: "prohibited" })).classification, "RED");
  assert.equal(classifyEligibility(facts({ hoaStatus: "HOA_PRESENT" })).classification, "RED");
  assert.equal(classifyEligibility(facts({
    densityResult: "FAIL", densityRadiusFt: 1000, densityThresholdPct: 2, densityStrs: 5, densityUnits: 180, densityPctAfter: 3.33,
  })).classification, "RED");
});

test("one blocking reason does not hide the others", () => {
  const r = classifyEligibility(facts({ zoningTreatment: "prohibited", spacingResult: "FAIL", nearestDistanceFt: 100, hoaStatus: "HOA_PRESENT" }));
  assert.equal(r.classification, "RED");
  assert.deepEqual(r.failures.filter((f) => f.severity === "fail").map((f) => f.code).sort(),
    ["HOA_PRESENT", "SPACING_FAIL", "ZONING_PROHIBITED"]);
  assert.match(r.summary, /\+2 more blocking reasons/);
});

// ── YELLOW: nothing says no, but something material is unverified ───────────
test("a conditional-use zone is YELLOW with a CUP flag, not RED", () => {
  const r = classifyEligibility(facts({ zoneCode: "R-1C", zoningTreatment: "conditional_use" }));
  assert.equal(r.classification, "YELLOW");
  assert.equal(r.cupRequired, "LIKELY");
  assert.equal(r.failures[0].code, "CUP_REQUIRED");
  assert.equal(r.failures[0].severity, "review");
});

test("a separation measured from a permit point is REVIEW, never a silent PASS", () => {
  const r = classifyEligibility(facts({ spacingResult: "REVIEW", nearestDistanceFt: 300, spacingMeasured: "permit_point" }));
  assert.equal(r.classification, "YELLOW");
  const f = r.failures.find((x) => x.code === "SPACING_APPROXIMATE")!;
  assert.match(f.message, /permit point/);
});

test("an unverified HOA blocks GREEN but not the property", () => {
  for (const hoaStatus of ["HOA_UNKNOWN", null] as const) {
    const r = classifyEligibility(facts({ hoaStatus }));
    assert.equal(r.classification, "YELLOW", String(hoaStatus));
    assert.ok(r.failures.some((f) => f.code === "HOA_UNVERIFIED"));
  }
});

test("screening from a point instead of a parcel is disclosed", () => {
  const r = classifyEligibility(facts({ subjectSource: "point", parcelMatchConfidence: null }));
  assert.equal(r.classification, "YELLOW");
  assert.ok(r.failures.some((f) => f.code === "PARCEL_NOT_MATCHED"));
});

test("a weak parcel match is disclosed even when the parcel was found", () => {
  assert.ok(codes(facts({ parcelMatchConfidence: 0.6 })).includes("LOW_PARCEL_CONFIDENCE"));
  assert.deepEqual(codes(facts({ parcelMatchConfidence: 0.9 })), [], "0.9 is the accepted threshold");
});

test("missing configuration is surfaced as a caveat, not swallowed", () => {
  assert.ok(codes(facts({ zoneCode: null })).includes("ZONING_UNKNOWN"));
  assert.ok(codes(facts({ zoningTreatment: null })).includes("ZONING_NOT_CONFIGURED"));
  assert.ok(codes(facts({ zoningTreatment: "review" })).includes("ZONING_REVIEW"));
  assert.ok(codes(facts({ spacingResult: "DATA_REQUIRED" })).includes("SPACING_RULE_MISSING"));
  assert.ok(codes(facts({ spacingResult: null })).includes("SPACING_NOT_RUN"));
});

// ── the density distinction the defaults depend on ─────────────────────────
test("NOT_CONFIGURED and DATA_REQUIRED are different claims", () => {
  // Lexington today: the 1,000-ft rule ships disabled because nobody has
  // confirmed it exists. That is not a caveat on the property.
  assert.equal(classifyEligibility(facts({ densityResult: "NOT_CONFIGURED" })).classification, "GREEN");
  assert.deepEqual(codes(facts({ densityResult: "NOT_CONFIGURED" })), []);

  // Once the rule is enabled, a missing denominator IS a caveat.
  const r = classifyEligibility(facts({ densityResult: "DATA_REQUIRED", densityRadiusFt: 1000, densityThresholdPct: 2 }));
  assert.equal(r.classification, "YELLOW");
  assert.ok(r.failures.some((f) => f.code === "DENSITY_DATA_REQUIRED"));
});

test("a density PASS adds nothing to report", () => {
  assert.deepEqual(codes(facts({ densityResult: "PASS", densityUnits: 214, densityStrs: 3, densityPct: 1.4 })), []);
});

// ── CUP mapping ─────────────────────────────────────────────────────────────
test("conditional use permit likelihood follows the treatment", () => {
  assert.equal(cupRequiredFor("conditional_use"), "LIKELY");
  assert.equal(cupRequiredFor("principal_use"), "NOT_REQUIRED");
  assert.equal(cupRequiredFor("accessory_use"), "NOT_REQUIRED");
  assert.equal(cupRequiredFor("review"), "UNKNOWN");
  assert.equal(cupRequiredFor("prohibited"), "UNKNOWN");
  assert.equal(cupRequiredFor(null), "UNKNOWN");
});

// ── row mapping ─────────────────────────────────────────────────────────────
test("a raw DB row maps onto the classifier input, with numerics coerced", () => {
  const f = factsFromRow({
    zone_code: "R-1C", zoning_treatment: "conditional_use",
    spacing_result: "PASS", spacing_ft: "600", nearest_distance_ft: "812.4",
    density_result: "NOT_CONFIGURED", hoa_status: "VERIFIED_NO_HOA",
    subject_source: "parcel", parcel_match_confidence: "0.95",
  });
  assert.equal(f.spacingFt, 600);
  assert.equal(f.nearestDistanceFt, 812.4);
  assert.equal(f.parcelMatchConfidence, 0.95);
  assert.equal(f.zoneCode, "R-1C");
});

test("an empty row defaults to unknown rather than to pass", () => {
  const r = classifyEligibility(factsFromRow({}));
  assert.equal(r.classification, "YELLOW");
  assert.equal(factsFromRow({}).hoaStatus, "HOA_UNKNOWN");
  assert.ok(codes(factsFromRow({})).includes("ZONING_UNKNOWN"));
});

test("badge labels distinguish 'no rule set' from 'data required'", () => {
  assert.equal(factLabel("NOT_CONFIGURED").label, "NO RULE SET");
  assert.equal(factLabel("NOT_CONFIGURED").tone, "neutral");
  assert.equal(factLabel("DATA_REQUIRED").label, "DATA REQUIRED");
  assert.equal(factLabel("DATA_REQUIRED").tone, "review");
  assert.equal(factLabel("FAIL").tone, "fail");
  assert.equal(factLabel(null).label, "NOT RUN");
});

// ── migration guards ────────────────────────────────────────────────────────
const sql = readFileSync(join(__dirname, "..", "supabase", "migrations", "0004_phase3.sql"), "utf8");

test("REGRESSION: the density test separates 'no rule' from 'no denominator'", () => {
  assert.ok(/NOT_CONFIGURED/.test(sql), "an unconfigured rule must not read as a data gap");
  assert.ok(/DATA_REQUIRED/.test(sql), "a configured rule with no denominator still reports honestly");
  assert.ok(!/round\(\(v_strs \+ 1\)::numeric \/ 0/.test(sql));
});

test("REGRESSION: eligibility facts are returned as one named type, so every caller gets the same shape", () => {
  assert.ok(/create type eligibility_facts as \(/.test(sql));
  assert.ok(/returns setof eligibility_facts/.test(sql));
  // PostgREST cannot pass a geometry argument; the callable entry points must not try
  assert.ok(/fn_eligibility_facts_for_parcel\(p_jurisdiction text, p_parcel_id bigint\)/.test(sql));
  assert.ok(/fn_eligibility_facts_at_point\(p_jurisdiction text, p_lng double precision, p_lat double precision\)/.test(sql));
});

test("REGRESSION: every recorded check stamps the rules version it was decided under", () => {
  const route = readFileSync(join(__dirname, "..", "src/app/api/eligibility/rerun/route.ts"), "utf8");
  assert.ok(/rules_version: row\.rules_version/.test(route));
  assert.ok(/fn_link_properties_to_parcels/.test(route), "parcels must be linked before screening");
});
