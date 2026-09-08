/**
 * Sixgen comparable engine v1 (spec §17–20, Phase 5).
 *
 * Pure: a subject property and Sixgen's trailing-twelve portfolio in, a weighted
 * forecast with its comps and its confidence out. SQL supplies the T12
 * aggregates; nothing here touches the database.
 *
 * The model is deliberately small and legible. Sixgen has seventeen listings —
 * that is not enough data to justify anything clever, and a regression fitted to
 * seventeen points would look authoritative while being noise. So: pick the
 * closest comps on the attributes that actually move nightly rate, weight them
 * by similarity, and report honestly how thin the basis is.
 *
 * What the source data cannot tell us, and what this does about it:
 *  · Occupancy is computed against calendar days, so it is a FLOOR — owner and
 *    maintenance blocks are unknown. Every occupancy figure here inherits that
 *    and the UI says so.
 *  · A listing that went live mid-window has months of zeros that are not
 *    vacancy. `monthsWithData` downweights those comps instead of averaging
 *    their pre-launch zeros into the market.
 *  · Revenue is attributed to the check-in month, so one long stay can dominate
 *    a month. That is why the basis is annual and the monthly curve is a shape
 *    applied to it, never a set of independent monthly predictions.
 */
import { projectRevenue, normalizeOccupancy, shiftOccupancy, grossYieldPct } from "../revenue";

export const COMPS_MODEL_VERSION = "sixgen-comps-v1.1";

export type CompProperty = {
  id: number;
  name: string;
  beds: number | null;
  baths: number | null;
  maxGuests: number | null;
  hotTub?: boolean | null;
  golfSim?: boolean | null;
  gameRoom?: boolean | null;
  pool?: boolean | null;
  firePit?: boolean | null;
  poolTable?: boolean | null;
  /** Trailing-twelve aggregates. */
  adr: number | null;
  occupancy: number | null;
  grossRevenue: number | null;
  monthsWithData: number | null;
  isPartialYear?: boolean | null;
};

export type Subject = {
  beds: number | null;
  baths?: number | null;
  maxGuests?: number | null;
  hotTub?: boolean | null;
  golfSim?: boolean | null;
  gameRoom?: boolean | null;
  pool?: boolean | null;
  firePit?: boolean | null;
  poolTable?: boolean | null;
  /** Used only for the yield figure, never for the revenue model. */
  price?: number | null;
};

export type ScoredComp = {
  comp: CompProperty;
  similarity: number;   // 0..1
  weight: number;       // normalized across the selected set
  reasons: string[];
};

export type Confidence = "HIGH" | "MEDIUM" | "LOW";

export type Forecast = {
  modelVersion: string;
  comps: ScoredComp[];
  compCount: number;
  /** Share of a full year of data behind the weighted comps, 0..1. */
  coverage: number;
  confidence: Confidence;
  confidenceReasons: string[];
  adr: number;
  occupancy: number;
  occupancyCap: number;
  annualRevenue: number;
  scenarios: {
    conservative: { adr: number; occupancy: number; revenue: number };
    base: { adr: number; occupancy: number; revenue: number };
    upside: { adr: number; occupancy: number; revenue: number };
  };
  grossYieldPct: number | null;
  monthly: { month: number; adr: number; occupancy: number; revenue: number }[] | null;
  notes: string[];
};

/** Amenities Sixgen actually differentiates on, and roughly what each is worth. */
const AMENITIES: { key: keyof Subject & keyof CompProperty; label: string; weight: number }[] = [
  { key: "hotTub", label: "hot tub", weight: 0.30 },
  { key: "golfSim", label: "golf simulator", weight: 0.25 },
  { key: "gameRoom", label: "game room", weight: 0.20 },
  { key: "pool", label: "pool", weight: 0.15 },
  { key: "firePit", label: "fire pit", weight: 0.05 },
  { key: "poolTable", label: "pool table", weight: 0.05 },
];

export const DEFAULT_MIN_SIMILARITY = 0.45;
export const DEFAULT_MAX_COMPS = 6;

/**
 * 0..1 similarity. Bedrooms dominate because they gate both the nightly rate and
 * the guest count a listing can serve; a 2BR and a 7BR are not the same business
 * however alike they look otherwise.
 */
export function similarity(subject: Subject, comp: CompProperty): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;

  // bedrooms — 50%
  if (subject.beds != null && comp.beds != null) {
    const gap = Math.abs(subject.beds - comp.beds);
    const bedScore = gap === 0 ? 1 : gap === 1 ? 0.62 : gap === 2 ? 0.28 : 0;
    score += 0.5 * bedScore;
    if (gap === 0) reasons.push(`${comp.beds} bd exact match`);
    else reasons.push(`${comp.beds} bd vs ${subject.beds} bd`);
  }

  // sleeps — 20%
  if (subject.maxGuests != null && comp.maxGuests != null && subject.maxGuests > 0) {
    const ratio = Math.min(subject.maxGuests, comp.maxGuests) / Math.max(subject.maxGuests, comp.maxGuests);
    score += 0.2 * ratio;
    if (ratio >= 0.9) reasons.push(`sleeps ${comp.maxGuests}`);
  } else {
    score += 0.2 * 0.5;   // unknown capacity is neutral, not disqualifying
  }

  // baths — 10%
  if (subject.baths != null && comp.baths != null) {
    const gap = Math.abs(subject.baths - comp.baths);
    score += 0.1 * (gap <= 0.5 ? 1 : gap <= 1 ? 0.7 : gap <= 2 ? 0.35 : 0);
  } else {
    score += 0.1 * 0.5;
  }

  // amenities — 20%, scored on overlap rather than the comp merely having more
  let amenityScore = 0, amenityTotal = 0;
  const matched: string[] = [];
  for (const a of AMENITIES) {
    amenityTotal += a.weight;
    const s = subject[a.key] === true;
    const c = comp[a.key] === true;
    if (s === c) { amenityScore += a.weight; if (s) matched.push(a.label); }
  }
  score += 0.2 * (amenityTotal > 0 ? amenityScore / amenityTotal : 0.5);
  if (matched.length) reasons.push(`shares ${matched.join(", ")}`);

  return { score: +Math.min(1, score).toFixed(3), reasons };
}

/**
 * Rank and select comps. A comp with no usable trailing-twelve revenue is
 * dropped outright — it cannot inform a forecast, and including it at weight
 * zero only inflates the apparent comp count.
 */
export function selectComps(
  subject: Subject,
  pool: CompProperty[],
  opts: { minSimilarity?: number; maxComps?: number } = {}
): ScoredComp[] {
  const minSim = opts.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
  const maxComps = opts.maxComps ?? DEFAULT_MAX_COMPS;

  const scored = pool
    .filter((c) => c.adr != null && c.adr > 0 && c.occupancy != null && (c.monthsWithData ?? 0) > 0)
    .map((comp) => {
      const { score, reasons } = similarity(subject, comp);
      // A part-year listing is real evidence, just less of it. Scale its
      // influence by how much of the year it actually traded.
      const coverage = Math.min(1, (comp.monthsWithData ?? 0) / 12);
      if (coverage < 1) reasons.push(`${comp.monthsWithData} of 12 months traded`);
      return { comp, similarity: score, weight: score * coverage, reasons };
    })
    .filter((s) => s.similarity >= minSim && s.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, maxComps);

  const total = scored.reduce((sum, s) => sum + s.weight, 0);
  return scored.map((s) => ({ ...s, weight: total > 0 ? +(s.weight / total).toFixed(4) : 0 }));
}

const weightedMean = (comps: ScoredComp[], pick: (c: CompProperty) => number | null): number => {
  let num = 0, den = 0;
  for (const s of comps) {
    const v = pick(s.comp);
    if (v == null || !Number.isFinite(v)) continue;
    num += v * s.weight; den += s.weight;
  }
  return den > 0 ? num / den : 0;
};

/** Weighted percentile over the comp set — the dispersion the scenarios use. */
export function weightedPercentile(comps: ScoredComp[], pick: (c: CompProperty) => number | null, p: number): number {
  const points = comps
    .map((s) => ({ v: pick(s.comp), w: s.weight }))
    .filter((x): x is { v: number; w: number } => x.v != null && Number.isFinite(x.v) && x.w > 0)
    .sort((a, b) => a.v - b.v);
  if (!points.length) return 0;
  if (points.length === 1) return points[0].v;

  const total = points.reduce((s, x) => s + x.w, 0);
  let acc = 0;
  for (const pt of points) {
    acc += pt.w;
    if (acc / total >= p) return pt.v;
  }
  return points[points.length - 1].v;
}

export function assessConfidence(comps: ScoredComp[], subject: Subject): { confidence: Confidence; coverage: number; reasons: string[] } {
  const reasons: string[] = [];
  if (!comps.length) return { confidence: "LOW", coverage: 0, reasons: ["No Sixgen listing is similar enough to compare against."] };

  const coverage = +comps.reduce((s, c) => s + c.weight * Math.min(1, (c.comp.monthsWithData ?? 0) / 12), 0).toFixed(3);
  const best = comps[0].similarity;
  const exactBeds = comps.filter((c) => subject.beds != null && c.comp.beds === subject.beds).length;

  if (comps.length < 3) reasons.push(`Only ${comps.length} comparable ${comps.length === 1 ? "listing" : "listings"} in the portfolio.`);
  if (best < 0.7) reasons.push(`The closest comparable is only a ${(best * 100).toFixed(0)}% match.`);
  if (!exactBeds) reasons.push("No Sixgen listing has the same bedroom count.");
  if (coverage < 0.8) reasons.push(`Comps cover ${(coverage * 100).toFixed(0)}% of a full trading year.`);

  let confidence: Confidence = "HIGH";
  if (comps.length < 3 || best < 0.7 || !exactBeds || coverage < 0.6) confidence = "MEDIUM";
  if (comps.length < 2 || best < 0.55 || coverage < 0.35) confidence = "LOW";
  if (confidence === "HIGH") reasons.push(`${comps.length} close comps with ${(coverage * 100).toFixed(0)}% year coverage.`);

  return { confidence, coverage, reasons };
}

/** Distribute an annual total across months by a seasonality shape. */
export function monthlyFromShape(
  annualRevenue: number, adr: number, shape: { month: number; adrIndex: number }[]
): { month: number; adr: number; occupancy: number; revenue: number }[] | null {
  if (shape.length !== 12) return null;
  const days = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const weights = shape.map((s, i) => Math.max(0, s.adrIndex) * days[i]);
  const total = weights.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return null;

  const rows = weights.map((w, i) => {
    const revenue = Math.round((annualRevenue * w) / total);
    const mAdr = Math.round(adr * Math.max(0.01, shape[i].adrIndex));
    const occ = mAdr > 0 ? +Math.min(1, revenue / (mAdr * days[i])).toFixed(3) : 0;
    return { month: i + 1, adr: mAdr, occupancy: occ, revenue };
  });
  // absorb rounding drift so the months reconcile exactly to the annual figure
  rows[rows.length - 1].revenue += annualRevenue - rows.reduce((a, r) => a + r.revenue, 0);
  return rows;
}

export function buildForecast(
  subject: Subject,
  pool: CompProperty[],
  opts: {
    occupancyCap?: number;
    availableNights?: number;
    seasonality?: { month: number; adrIndex: number }[];
    minSimilarity?: number;
    maxComps?: number;
  } = {}
): Forecast {
  const cap = opts.occupancyCap ?? 0.82;
  const nights = opts.availableNights ?? 365;
  const comps = selectComps(subject, pool, opts);
  const { confidence, coverage, reasons } = assessConfidence(comps, subject);
  const notes: string[] = [];

  if (!comps.length) {
    return {
      modelVersion: COMPS_MODEL_VERSION, comps: [], compCount: 0, coverage: 0,
      confidence: "LOW", confidenceReasons: reasons,
      adr: 0, occupancy: 0, occupancyCap: cap, annualRevenue: 0,
      scenarios: { conservative: { adr: 0, occupancy: 0, revenue: 0 }, base: { adr: 0, occupancy: 0, revenue: 0 }, upside: { adr: 0, occupancy: 0, revenue: 0 } },
      grossYieldPct: null, monthly: null,
      notes: ["No forecast produced: nothing in the Sixgen portfolio is comparable enough."],
    };
  }

  const adr = Math.round(weightedMean(comps, (c) => c.adr));
  const rawOcc = normalizeOccupancy(weightedMean(comps, (c) => c.occupancy));
  const occ = Math.min(rawOcc, cap);
  if (rawOcc > cap) notes.push(`Comparable occupancy averages ${(rawOcc * 100).toFixed(0)}%, capped at the ${(cap * 100).toFixed(0)}% underwriting ceiling.`);
  notes.push("Occupancy is measured against calendar days, so it is a floor: owner and maintenance blocks are not visible in the source data.");
  if (comps.some((c) => c.comp.isPartialYear)) notes.push("One or more comps traded for part of the year; their influence is scaled to the months they actually traded.");

  const annualRevenue = projectRevenue(adr, occ, nights, 1);   // occ is already capped

  const adrP25 = weightedPercentile(comps, (c) => c.adr, 0.25);
  const adrP75 = weightedPercentile(comps, (c) => c.adr, 0.75);
  const occP25 = weightedPercentile(comps, (c) => c.occupancy, 0.25);
  const occP75 = weightedPercentile(comps, (c) => c.occupancy, 0.75);

  const mk = (a: number, o: number) => {
    const occN = Math.min(normalizeOccupancy(o), cap);
    return { adr: Math.round(a), occupancy: +occN.toFixed(3), revenue: projectRevenue(a, occN, nights, 1) };
  };
  // a single comp has no dispersion; fall back to a documented spread
  const spread = comps.length >= 2;
  const scenarios = {
    conservative: spread ? mk(adrP25, occP25) : mk(adr * 0.87, shiftOccupancy(occ, -0.07)),
    base: mk(adr, occ),
    upside: spread ? mk(adrP75, occP75) : mk(adr * 1.13, shiftOccupancy(occ, +0.07)),
  };
  if (!spread) notes.push("Only one comparable listing, so the scenario range is a documented ±13% spread rather than observed dispersion.");

  return {
    modelVersion: COMPS_MODEL_VERSION,
    comps, compCount: comps.length, coverage,
    confidence, confidenceReasons: reasons,
    adr, occupancy: +occ.toFixed(3), occupancyCap: cap, annualRevenue,
    scenarios,
    grossYieldPct: subject.price ? grossYieldPct(annualRevenue, subject.price) : null,
    monthly: opts.seasonality ? monthlyFromShape(annualRevenue, adr, opts.seasonality) : null,
    notes,
  };
}
