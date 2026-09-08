/**
 * Eligibility classification (spec §16, Phase 3).
 *
 * PostGIS produces the facts (`fn_eligibility_facts`); this turns them into a
 * GREEN / RED / YELLOW call plus one explained row per reason. Pure — no I/O —
 * so every rule below is unit-tested, and the Test Address page and the batch
 * re-run share exactly one implementation.
 *
 * The three states mean:
 *   RED     a rule this tool can evaluate says no.
 *   YELLOW  nothing says no, but something material is unverified.
 *   GREEN   every check this tool can make passed, on evidence.
 *
 * GREEN is never a legal opinion. The footer disclaimer is part of the product.
 */
import type { Classification, HoaStatus } from "./types";

export type FactResult = "PASS" | "FAIL" | "REVIEW" | "DATA_REQUIRED" | "NOT_CONFIGURED" | null;
export type CupRequired = "LIKELY" | "POSSIBLE" | "NOT_REQUIRED" | "UNKNOWN";
export type Severity = "fail" | "review";

export type EligibilityFacts = {
  zoneCode: string | null;
  zoningTreatment: string | null;
  spacingResult: FactResult;
  spacingFt: number | null;
  nearestPermitId: number | null;
  nearestAddress: string | null;
  nearestDistanceFt: number | null;
  spacingMeasured: string | null;
  densityResult: FactResult;
  densityRadiusFt: number | null;
  densityThresholdPct: number | null;
  densityStrs: number | null;
  densityUnits: number | null;
  densityPct: number | null;
  densityPctAfter: number | null;
  hoaStatus: HoaStatus | null;
  subjectSource: "parcel" | "point" | null;
  parcelMatchConfidence: number | null;
};

export type Failure = { code: string; severity: Severity; message: string; evidence?: Record<string, unknown> };

export type EligibilityResult = {
  classification: Classification;
  cupRequired: CupRequired;
  failures: Failure[];
  /** One sentence an operator can read without opening the detail rows. */
  summary: string;
};

/** Parcel matches below this are not precise enough to assert a spacing result. */
export const MIN_PARCEL_CONFIDENCE = 0.9;

export function cupRequiredFor(treatment: string | null): CupRequired {
  switch (treatment) {
    case "conditional_use": return "LIKELY";
    case "principal_use":
    case "accessory_use": return "NOT_REQUIRED";
    default: return "UNKNOWN";   // 'review', 'prohibited', or not configured
  }
}

export function classifyEligibility(f: EligibilityFacts): EligibilityResult {
  const failures: Failure[] = [];
  const add = (code: string, severity: Severity, message: string, evidence?: Record<string, unknown>) =>
    failures.push({ code, severity, message, ...(evidence ? { evidence } : {}) });

  // ── zoning ────────────────────────────────────────────────────────────────
  if (!f.zoneCode) {
    add("ZONING_UNKNOWN", "review", "No zoning district was found for this location. Confirm the zone with LFUCG Planning.");
  } else {
    switch (f.zoningTreatment) {
      case "prohibited":
        add("ZONING_PROHIBITED", "fail", `Un-hosted short-term rentals are prohibited in ${f.zoneCode}.`, { zone: f.zoneCode });
        break;
      case "conditional_use":
        add("CUP_REQUIRED", "review", `${f.zoneCode} allows an un-hosted STR only as a conditional use — a Board of Adjustment permit is likely required.`, { zone: f.zoneCode });
        break;
      case "review":
        add("ZONING_REVIEW", "review", `${f.zoneCode} needs manual review; different rules apply here.`, { zone: f.zoneCode });
        break;
      case "principal_use":
      case "accessory_use":
        break;                                   // permitted, nothing to report
      default:
        add("ZONING_NOT_CONFIGURED", "review", `No STR treatment is configured for ${f.zoneCode}. Set it in Admin → STR Rules before relying on this result.`, { zone: f.zoneCode });
    }
  }

  // ── 600-ft separation ─────────────────────────────────────────────────────
  const dist = f.nearestDistanceFt;
  switch (f.spacingResult) {
    case "FAIL":
      add("SPACING_FAIL", "fail",
        `An existing blocking STR is ${dist ?? "?"} ft away — inside the ${f.spacingFt ?? "?"}-ft separation requirement.`,
        { permitId: f.nearestPermitId, address: f.nearestAddress, distanceFt: dist, requiredFt: f.spacingFt });
      break;
    case "REVIEW":
      add("SPACING_APPROXIMATE", "review",
        `The nearest blocking STR is about ${dist ?? "?"} ft away, but it is not matched to a parcel, so the distance was measured from its permit point rather than its property line. Match that permit before relying on this.`,
        { permitId: f.nearestPermitId, address: f.nearestAddress, distanceFt: dist, measured: f.spacingMeasured });
      break;
    case "DATA_REQUIRED":
      add("SPACING_RULE_MISSING", "review", "No separation rule is configured for this jurisdiction, so the 600-ft test did not run. Set spacing_ft in Admin → STR Rules.");
      break;
    case "PASS":
      break;
    default:
      add("SPACING_NOT_RUN", "review", "The separation test did not return a result.");
  }

  // ── density ───────────────────────────────────────────────────────────────
  // NOT_CONFIGURED means no density rule has been established for this
  // jurisdiction, which is not a caveat on the property. DATA_REQUIRED means a
  // rule IS in force and the denominator is missing — that is a caveat.
  switch (f.densityResult) {
    case "FAIL":
      add("DENSITY_FAIL", "fail",
        `Adding this property would put un-hosted STRs at ${f.densityPctAfter ?? "?"}% of dwelling units within ${f.densityRadiusFt ?? "?"} ft, over the ${f.densityThresholdPct ?? "?"}% limit.`,
        { strs: f.densityStrs, units: f.densityUnits, pctNow: f.densityPct, pctAfter: f.densityPctAfter, thresholdPct: f.densityThresholdPct });
      break;
    case "DATA_REQUIRED":
      add("DENSITY_DATA_REQUIRED", "review",
        `A density limit is in force but there is no dwelling-unit count for the ${f.densityRadiusFt ?? "?"}-ft radius, so the test could not be run.`,
        { radiusFt: f.densityRadiusFt, thresholdPct: f.densityThresholdPct, strs: f.densityStrs });
      break;
    case "PASS":
    case "NOT_CONFIGURED":
    default:
      break;
  }

  // ── HOA ───────────────────────────────────────────────────────────────────
  if (f.hoaStatus === "HOA_PRESENT") {
    add("HOA_PRESENT", "fail", "An HOA is on record for this property. HOA covenants commonly forbid short-term rentals regardless of zoning.");
  } else if (f.hoaStatus !== "VERIFIED_NO_HOA") {
    add("HOA_UNVERIFIED", "review", "HOA status is unverified. A $0 fee in a listing is not proof that there is no HOA.");
  }

  // ── measurement quality ───────────────────────────────────────────────────
  if (f.subjectSource === "point") {
    add("PARCEL_NOT_MATCHED", "review", "This property is not matched to a parcel, so distances were measured from a single point rather than the property line.");
  } else if (f.parcelMatchConfidence != null && f.parcelMatchConfidence < MIN_PARCEL_CONFIDENCE) {
    add("LOW_PARCEL_CONFIDENCE", "review",
      `The parcel match is only ${(f.parcelMatchConfidence * 100).toFixed(0)}% confident. Verify the parcel before relying on the separation result.`,
      { confidence: f.parcelMatchConfidence });
  }

  const fails = failures.filter((x) => x.severity === "fail");
  const reviews = failures.filter((x) => x.severity === "review");
  const classification: Classification = fails.length ? "RED" : reviews.length ? "YELLOW" : "GREEN";

  return {
    classification,
    cupRequired: cupRequiredFor(f.zoningTreatment),
    failures,
    summary: summarize(classification, fails, reviews),
  };
}

function summarize(c: Classification, fails: Failure[], reviews: Failure[]): string {
  if (c === "RED") {
    const lead = fails[0].message;
    return fails.length === 1 ? lead : `${lead} (+${fails.length - 1} more blocking ${fails.length === 2 ? "reason" : "reasons"})`;
  }
  if (c === "YELLOW") {
    const n = reviews.length;
    return `No rule blocks this property, but ${n} item${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} verification: ${reviews.map((r) => SHORT[r.code] ?? r.code).join(", ")}.`;
  }
  return "Passed every check this tool can make. Confirm with LFUCG Planning before acting.";
}

/** Compact labels used in the one-line summary and in table cells. */
const SHORT: Record<string, string> = {
  ZONING_UNKNOWN: "zoning unknown",
  ZONING_NOT_CONFIGURED: "zoning treatment not set",
  ZONING_REVIEW: "zoning needs review",
  CUP_REQUIRED: "conditional use permit",
  SPACING_APPROXIMATE: "separation measured from a point",
  SPACING_RULE_MISSING: "separation rule not set",
  SPACING_NOT_RUN: "separation not run",
  DENSITY_DATA_REQUIRED: "density denominator missing",
  HOA_UNVERIFIED: "HOA unverified",
  PARCEL_NOT_MATCHED: "no parcel match",
  LOW_PARCEL_CONFIDENCE: "weak parcel match",
};

/** Map a raw DB row from fn_eligibility_facts onto the classifier's input. */
export function factsFromRow(row: any, extra: Partial<EligibilityFacts> = {}): EligibilityFacts {
  const n = (v: any): number | null => (v == null || v === "" ? null : Number(v));
  return {
    zoneCode: row?.zone_code ?? null,
    zoningTreatment: row?.zoning_treatment ?? null,
    spacingResult: (row?.spacing_result ?? null) as FactResult,
    spacingFt: n(row?.spacing_ft),
    nearestPermitId: n(row?.nearest_permit_id),
    nearestAddress: row?.nearest_address ?? null,
    nearestDistanceFt: n(row?.nearest_distance_ft),
    spacingMeasured: row?.spacing_measured ?? null,
    densityResult: (row?.density_result ?? null) as FactResult,
    densityRadiusFt: n(row?.density_radius_ft),
    densityThresholdPct: n(row?.density_threshold_pct),
    densityStrs: n(row?.density_strs),
    densityUnits: n(row?.density_units),
    densityPct: n(row?.density_pct),
    densityPctAfter: n(row?.density_pct_after),
    hoaStatus: (row?.hoa_status ?? "HOA_UNKNOWN") as HoaStatus,
    subjectSource: (row?.subject_source ?? null) as "parcel" | "point" | null,
    parcelMatchConfidence: n(row?.parcel_match_confidence),
    ...extra,
  };
}

/** Display helper: badge text + tone for a raw test result. */
export function factLabel(result: FactResult): { label: string; tone: "pass" | "review" | "fail" | "neutral" } {
  switch (result) {
    case "PASS": return { label: "PASS", tone: "pass" };
    case "FAIL": return { label: "FAIL", tone: "fail" };
    case "REVIEW": return { label: "REVIEW", tone: "review" };
    case "DATA_REQUIRED": return { label: "DATA REQUIRED", tone: "review" };
    case "NOT_CONFIGURED": return { label: "NO RULE SET", tone: "neutral" };
    default: return { label: "NOT RUN", tone: "neutral" };
  }
}
