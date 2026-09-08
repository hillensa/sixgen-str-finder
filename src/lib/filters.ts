/**
 * Sixgen hard acquisition filters (spec §14). Pure functions — no I/O — so they
 * are unit-tested and reused by the import pipeline, refresh diff, and Top 25.
 */
import type { HoaStatus } from "./types";

export type AcquisitionFilters = {
  min_beds: number;        // 4
  min_price: number;       // 400000
  hoa_rule: "VERIFIED_NO_HOA_ONLY" | "EXCLUDE_KNOWN_HOA" | "IGNORE";
};
export const DEFAULT_FILTERS: AcquisitionFilters = { min_beds: 4, min_price: 400000, hoa_rule: "VERIFIED_NO_HOA_ONLY" };

export type FilterInput = {
  beds: number | null | undefined;
  price: number | null | undefined;
  hoa_status: HoaStatus | null | undefined;
  status?: string | null;      // listing status
};

export type FilterOutcome = {
  /** enters the fully-qualified pool (Top 25 eligible) */
  qualified: boolean;
  /** passes everything except HOA is unknown → "Needs HOA Verification" list */
  needsHoaVerification: boolean;
  reasons: string[];
};

export function applyHardFilters(input: FilterInput, f: AcquisitionFilters = DEFAULT_FILTERS): FilterOutcome {
  const reasons: string[] = [];
  const beds = input.beds ?? null;
  const price = input.price ?? null;
  const hoa: HoaStatus = input.hoa_status ?? "HOA_UNKNOWN";

  if (input.status && input.status !== "active") reasons.push(`Listing status is ${input.status}, not active`);
  if (beds === null) reasons.push("Bedroom count missing");
  else if (beds < f.min_beds) reasons.push(`${beds} bedrooms < minimum ${f.min_beds}`);
  if (price === null) reasons.push("List price missing");
  else if (price < f.min_price) reasons.push(`$${price.toLocaleString()} < minimum $${f.min_price.toLocaleString()}`);

  let hoaBlocks = false;
  let hoaUnknown = false;
  if (f.hoa_rule !== "IGNORE") {
    if (hoa === "HOA_PRESENT") { hoaBlocks = true; reasons.push("HOA present"); }
    else if (hoa === "HOA_UNKNOWN") {
      if (f.hoa_rule === "VERIFIED_NO_HOA_ONLY") hoaUnknown = true; // not blocked, but not qualified
    }
  }

  const baseOk = reasons.length === 0 && !hoaBlocks;
  return {
    qualified: baseOk && !hoaUnknown,
    needsHoaVerification: baseOk && hoaUnknown,
    reasons: hoaUnknown && baseOk ? ["HOA status unknown — verification required"] : reasons,
  };
}

/** Normalize a provider HOA field into the tri-state. `$0` alone is NOT proof of no HOA. */
export function hoaStatusFrom(opts: { fee?: number | null; flag?: boolean | null; verified?: boolean }): HoaStatus {
  if (opts.verified) return opts.flag ? "HOA_PRESENT" : "VERIFIED_NO_HOA";
  if (opts.flag === true) return "HOA_PRESENT";
  if (opts.fee != null && opts.fee > 0) return "HOA_PRESENT";
  return "HOA_UNKNOWN";
}
