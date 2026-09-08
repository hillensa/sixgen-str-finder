/**
 * Acquisition scoring (spec §22–24, Phase 6).
 *
 * Eligibility is a GATE, not a factor. A property that fails a rule this tool
 * can evaluate is not ranked at all — scoring it 40/100 and letting it sit
 * mid-table would be worse than useless, because the number invites someone to
 * trade off "illegal" against "high yield".
 *
 * Everything that survives the gate is scored on weighted factors read from
 * `scoring_weights`, so the ranking is configuration. Factors are normalized
 * across the candidate pool rather than against absolute thresholds: a 9% yield
 * is only good relative to what else is on the market this week.
 *
 * Pure. The whole pool goes in, ranked results come out.
 */
import type { HoaStatus } from "../types";

export const SCORING_MODEL_VERSION = "sixgen-score-v1.0";

export type Candidate = {
  propertyId: number;
  address: string;
  listPrice: number | null;
  beds: number | null;
  baths: number | null;
  sqft: number | null;
  lotSqft: number | null;
  basement: boolean | null;
  finishedBasement: boolean | null;
  pool: boolean | null;
  garage: boolean | null;
  lat: number | null;
  lng: number | null;
  hoaStatus: HoaStatus | null;
  classification: string | null;      // GREEN | YELLOW | RED | null
  eligibilitySummary: string | null;
  forecastRevenue: number | null;
  forecastConfidence: string | null;  // HIGH | MEDIUM | LOW
  compCount: number | null;
  compCoverage: number | null;
  status: string | null;              // listing status
};

export type DemandPoint = { lat: number; lng: number; t12Revenue: number; name: string };
export type Weight = { factorKey: string; factorName: string; weight: number };

export type FactorScore = {
  raw: number | null;
  normalized: number | null;
  weight: number;
  points: number;
  note?: string;
};

export type ScoredCandidate = {
  candidate: Candidate;
  score: number | null;
  rank: number | null;
  gated: boolean;
  gateReason: string | null;
  breakdown: Record<string, FactorScore>;
  unavailableFactors: string[];
};

export type ScoreResult = {
  modelVersion: string;
  ranked: ScoredCandidate[];
  gated: ScoredCandidate[];
  needsHoaVerification: ScoredCandidate[];
  requiresReview: ScoredCandidate[];
  weightsUsed: Weight[];
};

/** Where a factor cannot be computed at all, for the whole pool. */
const UNAVAILABLE = Symbol("unavailable");
type RawValue = number | null | typeof UNAVAILABLE;

// ─────────────────────────── the gate ───────────────────────────────────────

/**
 * Reasons a property is excluded from the ranking outright. Note what is NOT
 * here: an unverified HOA and a YELLOW classification do not gate. They are
 * unknowns, not failures, and they get their own lists.
 */
export function gateReason(c: Candidate): string | null {
  if (c.classification === "RED") return c.eligibilitySummary ?? "Fails an eligibility rule.";
  if (c.status && c.status !== "active") return `Listing is ${c.status}, not active.`;
  if (c.listPrice == null) return "No list price published, so it cannot be ranked on yield.";
  if (c.forecastRevenue == null) return "No revenue forecast yet — run the Sixgen comparables.";
  if (c.forecastRevenue <= 0) return "The comparable engine could not produce a revenue figure for this property.";
  return null;
}

// ─────────────────────────── factors ────────────────────────────────────────

const haversineMiles = (aLat: number, aLng: number, bLat: number, bLng: number): number => {
  const R = 3958.8, rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad, dLng = (bLng - aLng) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
};

/**
 * Amenities the Sixgen portfolio shows people pay for, and which a house can be
 * given after purchase. Scored on what is MISSING — that is the upside.
 */
const ADDABLE_AMENITIES = ["hot tub", "golf simulator", "game room", "fire pit"];

const FACTORS: Record<string, { label: string; higherIsBetter: boolean; compute: (c: Candidate, ctx: Context) => RawValue }> = {
  revenue_yield: {
    label: "Revenue yield", higherIsBetter: true,
    compute: (c) => (c.listPrice && c.forecastRevenue ? c.forecastRevenue / c.listPrice : null),
  },
  absolute_revenue: {
    label: "Absolute revenue", higherIsBetter: true,
    compute: (c) => c.forecastRevenue,
  },
  comp_strength: {
    label: "Comparable strength", higherIsBetter: true,
    compute: (c) => {
      if (c.compCount == null || c.compCount === 0) return null;
      const conf = c.forecastConfidence === "HIGH" ? 1 : c.forecastConfidence === "MEDIUM" ? 0.6 : 0.3;
      const coverage = c.compCoverage == null ? 0.5 : Number(c.compCoverage);
      return conf * Math.min(1, coverage) * Math.min(1, c.compCount / 4);
    },
  },
  guest_capacity: {
    label: "Guest capacity", higherIsBetter: true,
    // capacity drives nightly rate; two guests per bedroom is the seeded rule
    compute: (c, ctx) => (c.beds == null ? null : c.beds * ctx.guestsPerBedroom),
  },
  bedroom_opportunity: {
    label: "Bedroom opportunity", higherIsBetter: true,
    /**
     * Room to add a bedroom, which is the cheapest way to move revenue. Proxied
     * by floor area per existing bedroom plus an unfinished basement — a house
     * with generous rooms and a dry basement can gain one; a tight one cannot.
     */
    compute: (c) => {
      if (c.sqft == null || c.beds == null || c.beds <= 0) return null;
      const perBed = c.sqft / c.beds;
      const headroom = Math.max(0, Math.min(1, (perBed - 400) / 500));
      const basementBonus = c.basement && !c.finishedBasement ? 0.35 : 0;
      return Math.min(1, headroom + basementBonus);
    },
  },
  price_efficiency: {
    label: "Price efficiency", higherIsBetter: false,   // lower $/sqft is better
    compute: (c) => (c.listPrice && c.sqft && c.sqft > 0 ? c.listPrice / c.sqft : null),
  },
  amenity_potential: {
    label: "Amenity potential", higherIsBetter: true,
    /** How much of the paid-for amenity set is still missing and addable. */
    compute: (c) => {
      const lot = c.lotSqft ?? null;
      // a hot tub and a fire pit need outdoor space; a game room needs a basement
      const canOutdoor = lot == null ? 0.5 : lot >= 6000 ? 1 : lot >= 3000 ? 0.6 : 0.2;
      const canIndoor = c.basement ? 1 : 0.3;
      const missing = (c.pool ? 0 : 0.15) + 0.35 * canOutdoor + 0.3 * canIndoor + 0.2;
      return Math.min(1, missing / ADDABLE_AMENITIES.length * 2);
    },
  },
  location_demand: {
    label: "Location demand", higherIsBetter: true,
    /**
     * Proximity to Sixgen's own producing listings, weighted by what they earn.
     * There is no third-party demand feed wired in; these seventeen points are
     * the demand evidence the business actually owns. Where a property has no
     * coordinates, or no portfolio geography is loaded, the factor is reported
     * unavailable and its weight is redistributed.
     */
    compute: (c, ctx) => {
      if (!ctx.demand.length) return UNAVAILABLE;
      if (c.lat == null || c.lng == null) return null;
      let acc = 0;
      for (const d of ctx.demand) {
        const miles = haversineMiles(c.lat, c.lng, d.lat, d.lng);
        acc += d.t12Revenue / Math.pow(1 + miles, 2);   // inverse-square falloff
      }
      return acc;
    },
  },
};

type Context = { demand: DemandPoint[]; guestsPerBedroom: number };

/** Min–max normalize to 0..1 across the pool, inverting where lower is better. */
function normalize(values: (number | null)[], higherIsBetter: boolean): (number | null)[] {
  const present = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (!present.length) return values.map(() => null);
  const min = Math.min(...present), max = Math.max(...present);
  if (max === min) return values.map((v) => (v == null ? null : 0.5));   // no spread: everyone is average
  return values.map((v) => {
    if (v == null || !Number.isFinite(v)) return null;
    const n = (v - min) / (max - min);
    return higherIsBetter ? n : 1 - n;
  });
}

export function scoreCandidates(
  candidates: Candidate[],
  weights: Weight[],
  opts: { demand?: DemandPoint[]; guestsPerBedroom?: number } = {}
): ScoreResult {
  const ctx: Context = { demand: opts.demand ?? [], guestsPerBedroom: opts.guestsPerBedroom ?? 2 };
  const usable = weights.filter((w) => FACTORS[w.factorKey] && w.weight > 0);

  const gated: ScoredCandidate[] = [];
  const open: Candidate[] = [];
  for (const c of candidates) {
    const reason = gateReason(c);
    if (reason) {
      gated.push({ candidate: c, score: null, rank: null, gated: true, gateReason: reason, breakdown: {}, unavailableFactors: [] });
    } else open.push(c);
  }

  // raw values per factor across the surviving pool
  const raw = new Map<string, RawValue[]>();
  const poolUnavailable: string[] = [];
  for (const w of usable) {
    const values = open.map((c) => FACTORS[w.factorKey].compute(c, ctx));
    if (values.length && values.every((v) => v === UNAVAILABLE)) poolUnavailable.push(w.factorKey);
    raw.set(w.factorKey, values);
  }

  const normalized = new Map<string, (number | null)[]>();
  for (const w of usable) {
    const values = (raw.get(w.factorKey) ?? []).map((v) => (v === UNAVAILABLE ? null : v));
    normalized.set(w.factorKey, normalize(values, FACTORS[w.factorKey].higherIsBetter));
  }

  const scored: ScoredCandidate[] = open.map((c, i) => {
    const breakdown: Record<string, FactorScore> = {};
    const unavailable: string[] = [];

    // available weight is redistributed rather than counted as zero — a missing
    // input must not look like a bad input
    let availableWeight = 0;
    for (const w of usable) {
      const n = normalized.get(w.factorKey)![i];
      if (n == null) unavailable.push(w.factorKey); else availableWeight += w.weight;
    }

    let score = 0;
    for (const w of usable) {
      const rawV = raw.get(w.factorKey)![i];
      const n = normalized.get(w.factorKey)![i];
      const effective = n == null ? 0 : availableWeight > 0 ? w.weight / availableWeight : 0;
      const points = n == null ? 0 : +(n * effective * 100).toFixed(2);
      score += points;
      breakdown[w.factorKey] = {
        raw: rawV === UNAVAILABLE ? null : rawV,
        normalized: n == null ? null : +n.toFixed(4),
        weight: +effective.toFixed(4),
        points,
        note: n == null
          ? (poolUnavailable.includes(w.factorKey)
              ? "Not available for any candidate; its weight was redistributed."
              : "Not available for this property; its weight was redistributed.")
          : undefined,
      };
    }

    return {
      candidate: c, score: +score.toFixed(2), rank: null, gated: false, gateReason: null,
      breakdown, unavailableFactors: unavailable,
    };
  });

  scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  scored.forEach((s, i) => { s.rank = i + 1; });

  return {
    modelVersion: SCORING_MODEL_VERSION,
    ranked: scored,
    gated,
    // side lists: things that are not disqualified but are not clean either
    needsHoaVerification: scored.filter((s) => s.candidate.hoaStatus !== "VERIFIED_NO_HOA"),
    requiresReview: scored.filter((s) => s.candidate.classification === "YELLOW"),
    weightsUsed: usable,
  };
}

export const factorLabel = (key: string): string => FACTORS[key]?.label ?? key;
export const knownFactors = (): string[] => Object.keys(FACTORS);
