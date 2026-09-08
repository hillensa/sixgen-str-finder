import type { StrRule } from "./types";

export const RULE_KEYS = [
  "spacing_ft", "density_radius_ft", "density_max_pct", "occupancy_ceiling",
  "max_guests_per_bedroom", "zoning_treatment",
] as const;

export const ZONING_TREATMENTS = ["principal_use", "accessory_use", "conditional_use", "prohibited", "review"] as const;

/** Resolve the zoning treatment for a zone from the rule set (client-side helper). */
export function zoningTreatmentFor(rules: StrRule[], zone: string | null | undefined): string | null {
  if (!zone) return null;
  const z = zone.toUpperCase();
  const r = rules.find((x) => x.enabled && x.rule_key === "zoning_treatment" && (x.applicable_zoning ?? []).map((s) => s.toUpperCase()).includes(z));
  return r?.value_text ?? null;
}

export function ruleNum(rules: StrRule[], key: string): number | null {
  const r = rules.filter((x) => x.enabled && x.rule_key === key && x.value_num != null)
    .sort((a, b) => (b.effective_date > a.effective_date ? 1 : -1))[0];
  return r?.value_num ?? null;
}

export function treatmentLabel(t: string | null): { label: string; tone: "pass" | "review" | "fail" | "neutral" } {
  switch (t) {
    case "principal_use": return { label: "Permitted (principal use)", tone: "pass" };
    case "accessory_use": return { label: "Permitted (accessory use)", tone: "pass" };
    case "conditional_use": return { label: "Conditional Use Permit likely required", tone: "review" };
    case "prohibited": return { label: "Prohibited", tone: "fail" };
    case "review": return { label: "Requires manual review", tone: "review" };
    default: return { label: "Zoning treatment not configured", tone: "neutral" };
  }
}
