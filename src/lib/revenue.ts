/**
 * Revenue math primitives (spec §17, §20). The comparable-property engine
 * (Phase 5) supplies ADR/occupancy inputs; these functions turn them into
 * revenue and scenario ranges and are unit-tested.
 */
export const MODEL_VERSION = "sixgen-comps-v1.0";

export function projectRevenue(adr: number, occupancy: number, availableNights = 365, occupancyCeiling = 0.82): number {
  if (!Number.isFinite(adr) || adr <= 0) return 0;
  const occ = normalizeOccupancy(occupancy);
  const capped = Math.min(occ, occupancyCeiling);
  return Math.round(adr * capped * availableNights);
}

/** Accepts 0.67 or 67 → 0.67. Values above 100 clamp to 1. */
export function normalizeOccupancy(o: number): number {
  if (!Number.isFinite(o) || o < 0) return 0;
  if (o <= 1) return o;
  return Math.min(1, o / 100);
}

/**
 * Nudge an already-normalized occupancy without letting it re-enter
 * normalizeOccupancy as a "percentage".
 *
 * 0.95 + 0.07 = 1.02, which normalizeOccupancy used to read as 1.02% and divide
 * by 100 — the upside scenario came out below the conservative one. Occupancy is
 * a fraction here, so it is simply clamped to [0, 1].
 */
export const shiftOccupancy = (occ: number, delta: number): number =>
  Math.min(1, Math.max(0, normalizeOccupancy(occ) + delta));

export type Scenario = { adr: number; occupancy: number; revenue: number };
export type ScenarioSet = { conservative: Scenario; base: Scenario; upside: Scenario };

/**
 * Derive three scenarios from comparable dispersion when available
 * (p25 / weighted-mean / p75), else from a documented spread around base.
 */
export function buildScenarios(
  base: { adr: number; occupancy: number },
  dispersion?: { adrP25: number; adrP75: number; occP25: number; occP75: number },
  nights = 365,
  ceiling = 0.82
): ScenarioSet {
  const mk = (adr: number, occ: number): Scenario => ({ adr: Math.round(adr), occupancy: +normalizeOccupancy(occ).toFixed(3), revenue: projectRevenue(adr, occ, nights, ceiling) });
  if (dispersion) {
    return {
      conservative: mk(dispersion.adrP25, dispersion.occP25),
      base: mk(base.adr, base.occupancy),
      upside: mk(dispersion.adrP75, dispersion.occP75),
    };
  }
  // fallback spread — documented, not hidden. shiftOccupancy clamps rather than
  // re-normalizing, so a high base occupancy cannot invert the ordering.
  return {
    conservative: mk(base.adr * 0.87, shiftOccupancy(base.occupancy, -0.07)),
    base: mk(base.adr, base.occupancy),
    upside: mk(base.adr * 1.13, shiftOccupancy(base.occupancy, +0.07)),
  };
}

/** Distribute an annual forecast across months by a seasonality curve; reconciles to the annual total. */
export function monthlyFromSeasonality(annualRevenue: number, adr: number, curve: number[]): { month: number; adr: number; occupancy: number; revenue: number }[] {
  const days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const weights = curve.map((c, i) => c * days[i]);
  const total = weights.reduce((a, b) => a + b, 0);
  const rows = weights.map((w, i) => {
    const revenue = Math.round((annualRevenue * w) / total);
    const mAdr = Math.round(adr * curve[i]);
    const occ = mAdr > 0 ? +(revenue / (mAdr * days[i])).toFixed(3) : 0;
    return { month: i + 1, adr: mAdr, occupancy: occ, revenue };
  });
  // fix rounding drift so months sum exactly to annual
  const drift = annualRevenue - rows.reduce((a, r) => a + r.revenue, 0);
  rows[rows.length - 1].revenue += drift;
  return rows;
}

export function grossYieldPct(annualRevenue: number, price: number | null | undefined): number {
  if (!price || price <= 0) return 0;
  return +((annualRevenue / price) * 100).toFixed(1);
}

/** Wheelhouse CON seasonality for Lexington (Keeneland April/October peaks). */
export const LEXINGTON_SEASONALITY = [0.73, 0.75, 0.86, 1.0, 0.93, 0.96, 0.99, 0.98, 0.96, 1.02, 0.85, 0.75];
