/**
 * Address → coordinates for the permit import pipeline (Phase 2).
 *
 * Order of preference, and why:
 *   1. LFUCG Address_Point exact match  — the city's own E911 file. Authoritative.
 *   2. LFUCG Address_Point fuzzy match  — same street number, similar street name.
 *   3. US Census onelineaddress         — last resort; interpolated, so never
 *                                         confident enough to be called "matched".
 *
 * Results are cached in `geocode_cache` (including misses) so re-running an
 * import of the same 1,012-row file does not re-query the city 1,012 times.
 * Confidence is reported honestly: only tier 1 can reach the 0.9 threshold that
 * `matchStatusFor` treats as matched.
 */
import { queryAddressPoints, sqlLiteral, likeLiteral, type AddressPoint } from "./arcgis";
import { parseAddress, addressSimilarity } from "./address";

export type GeocodeMethod = "address_point" | "address_point_fuzzy" | "census";
export type GeocodeCandidate = { address: string; lat: number; lng: number; score: number };
export type GeocodeResult = {
  lat: number; lng: number;
  matchedAddress: string;
  confidence: number;
  method: GeocodeMethod;
  candidates: GeocodeCandidate[];
};

const CENSUS = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";

/** Cache key — the canonical address plus unit, so 12A and 12B do not share a hit. */
export const geocodeKey = (raw: string): string => {
  const p = parseAddress(raw);
  return `${p.normalized}${p.unit ? `#${p.unit}` : ""}`;
};

function rank(target: string, pts: AddressPoint[]): GeocodeCandidate[] {
  return pts
    .map((p) => ({ address: p.address, lat: p.lat, lng: p.lng, score: addressSimilarity(target, p.address) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

async function fromAddressPoints(layerUrl: string, raw: string): Promise<GeocodeResult | null> {
  const p = parseAddress(raw);
  if (!p.normalized) return null;

  // tier 1 — exact canonical string
  const exact = await queryAddressPoints(layerUrl, `ADDRESS = ${sqlLiteral(p.normalized)}`, 4, 86400);
  if (exact.length) {
    const c = rank(p.normalized, exact);
    return {
      lat: exact[0].lat, lng: exact[0].lng, matchedAddress: exact[0].address,
      // one unambiguous hit is as good as this data gets; several identical
      // addresses (a duplexed point file) is still a hit but not a certainty
      confidence: exact.length === 1 ? 0.97 : 0.92,
      method: "address_point", candidates: c,
    };
  }
  if (!p.number || !p.street) return null;

  // tier 2 — same house number, street name prefix
  const streetHead = p.street.split(" ")[0];
  const where = `ADDRESS LIKE ${likeLiteral(`${p.number} `)} AND ADDRESS LIKE '%${streetHead.replace(/'/g, "''")}%'`;
  const near = await queryAddressPoints(layerUrl, where, 12, 86400);
  const ranked = rank(p.normalized, near);
  if (!ranked.length) return null;
  const best = ranked[0];
  const runnerUp = ranked[1]?.score ?? 0;
  // an ambiguous field (two candidates within 0.05) never scores as certain
  const confidence = Math.min(0.88, best.score - (best.score - runnerUp < 0.05 ? 0.15 : 0));
  if (confidence < 0.5) return null;
  return { lat: best.lat, lng: best.lng, matchedAddress: best.address, confidence: +confidence.toFixed(3), method: "address_point_fuzzy", candidates: ranked };
}

async function fromCensus(raw: string, zip: string | null): Promise<GeocodeResult | null> {
  const p = parseAddress(raw);
  const line = `${p.normalized}, Lexington, KY${zip ? ` ${zip}` : ""}`;
  const url = `${CENSUS}?address=${encodeURIComponent(line)}&benchmark=Public_AR_Current&format=json`;
  const res = await fetch(url, { next: { revalidate: 86400 } } as any);
  if (!res.ok) return null;
  const j: any = await res.json().catch(() => null);
  const m = j?.result?.addressMatches?.[0];
  if (!m?.coordinates) return null;
  const sim = addressSimilarity(p.normalized, String(m.matchedAddress ?? ""));
  if (sim === 0) return null;                     // different house number — not our address
  return {
    lat: Number(m.coordinates.y), lng: Number(m.coordinates.x),
    matchedAddress: String(m.matchedAddress ?? line),
    // interpolated along a street centerline: useful for a map pin, never
    // precise enough to assert a parcel
    confidence: Math.min(0.7, +(sim * 0.7).toFixed(3)),
    method: "census",
    candidates: [{ address: String(m.matchedAddress ?? line), lat: Number(m.coordinates.y), lng: Number(m.coordinates.x), score: sim }],
  };
}

/** Geocode one address, reading and writing the `geocode_cache` table. */
export async function geocodeOne(
  db: any,
  j: { id: string; gis_address_url: string | null },
  raw: string,
  zip: string | null = null,
  opts: { useCensus?: boolean } = {}
): Promise<GeocodeResult | null> {
  const key = geocodeKey(raw);
  if (!key) return null;

  const { data: hit } = await db.from("geocode_cache").select("*").eq("jurisdiction_id", j.id).eq("query_norm", key).maybeSingle();
  if (hit) {
    if (hit.lat == null || hit.lng == null) return null;      // cached miss
    return { lat: hit.lat, lng: hit.lng, matchedAddress: hit.matched_address ?? raw, confidence: Number(hit.confidence ?? 0), method: (hit.method ?? "address_point") as GeocodeMethod, candidates: hit.candidates ?? [] };
  }

  let result: GeocodeResult | null = null;
  try {
    if (j.gis_address_url) result = await fromAddressPoints(j.gis_address_url, raw);
    if (!result && opts.useCensus !== false) result = await fromCensus(raw, zip);
  } catch {
    return null;                                              // transient failure: do not poison the cache
  }

  await db.from("geocode_cache").upsert({
    jurisdiction_id: j.id, query_norm: key,
    matched_address: result?.matchedAddress ?? null,
    lat: result?.lat ?? null, lng: result?.lng ?? null,
    confidence: result?.confidence ?? null, method: result?.method ?? null,
    candidates: result?.candidates ?? null,
  }, { onConflict: "jurisdiction_id,query_norm" });

  return result;
}

/**
 * Geocode a batch with bounded concurrency. Returns a map keyed by
 * `geocodeKey(address)`, so callers with duplicate addresses pay once.
 */
export async function geocodeMany(
  db: any,
  j: { id: string; gis_address_url: string | null },
  items: { address: string; zip: string | null }[],
  opts: { concurrency?: number; useCensus?: boolean; onProgress?: (done: number, total: number) => void } = {}
): Promise<Map<string, GeocodeResult | null>> {
  const unique = new Map<string, { address: string; zip: string | null }>();
  for (const it of items) {
    const k = geocodeKey(it.address);
    if (k && !unique.has(k)) unique.set(k, it);
  }
  const entries = [...unique.entries()];
  const out = new Map<string, GeocodeResult | null>();
  const width = Math.max(1, Math.min(opts.concurrency ?? 6, 12));
  let cursor = 0, done = 0;

  await Promise.all(Array.from({ length: width }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= entries.length) return;
      const [key, it] = entries[i];
      out.set(key, await geocodeOne(db, j, it.address, it.zip, { useCensus: opts.useCensus }));
      opts.onProgress?.(++done, entries.length);
    }
  }));
  return out;
}
