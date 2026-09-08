/**
 * Coordinate resolution for incoming listings.
 *
 * MLS exports routinely arrive without latitude/longitude — flexmls carries the
 * fields but they are not in a default export view, so an otherwise complete CSV
 * lands with every column except a pin. Those rows used to disappear inside
 * `normalizeRow`, which is the worst way to lose data: no count, no reason.
 *
 * Resolution runs in three tiers, cheapest and most trustworthy first:
 *   1. the payload's own coordinate            — confidence 1
 *   2. the pin already stored for this listing — confidence 1, and free
 *   3. the geocoder (LFUCG address points, then US Census)
 *
 * The confidence travels with the coordinate rather than being discarded. A
 * Census result is interpolated along a street centerline and can land on the
 * neighbouring parcel, which would change the 600-ft separation answer; it must
 * not be stored as though it were surveyed. `fn_link_properties_to_parcels`
 * caps parcel_match_confidence by this number, so an interpolated pin trips the
 * existing LOW_PARCEL_CONFIDENCE review instead of reporting a confident GREEN.
 *
 * Everything here is pure so it can be tested without a database or a network:
 * `refresh.ts` performs the I/O and hands the results back in.
 */
import type { NormalizedListing, ParsedListing } from "../providers/listings";

export type CoordinateSource = "provider" | "known_property" | "address_point" | "address_point_fuzzy" | "census";

export type LocatedListing = NormalizedListing & {
  coordinateSource: CoordinateSource;
  /** 1 when the coordinate was given to us; the geocoder's own score otherwise. */
  coordinateConfidence: number;
};

export type UnresolvedListing = { externalId: string; address: string; reason: string };

/** A coordinate the caller already holds — the stored property pin. */
export type KnownPin = { lat: number | null; lng: number | null };

const usable = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);

/**
 * Split parsed rows into those already located and those needing a geocoder.
 *
 * `known` is keyed by external id: a listing we have seen before already has a
 * property row with a pin, and re-geocoding it would spend a network call to
 * learn something we stored last time.
 */
export function planCoordinates(
  parsed: ParsedListing[],
  known: Map<string, KnownPin> = new Map()
): { located: LocatedListing[]; needGeocode: ParsedListing[] } {
  const located: LocatedListing[] = [];
  const needGeocode: ParsedListing[] = [];

  for (const p of parsed) {
    if (usable(p.lat) && usable(p.lng)) {
      located.push({ ...p, lat: p.lat, lng: p.lng, coordinateSource: "provider", coordinateConfidence: 1 });
      continue;
    }
    const prior = known.get(p.externalId);
    if (prior && usable(prior.lat) && usable(prior.lng)) {
      located.push({ ...p, lat: prior.lat, lng: prior.lng, coordinateSource: "known_property", coordinateConfidence: 1 });
      continue;
    }
    needGeocode.push(p);
  }
  return { located, needGeocode };
}

export type GeocodeHit = { lat: number; lng: number; confidence: number; method: CoordinateSource };

/**
 * Attach geocoder output to the rows that needed it.
 *
 * `keyOf` is injected rather than imported so this module stays free of the
 * network layer; callers pass `geocodeKey`.
 */
export function applyGeocode(
  needGeocode: ParsedListing[],
  results: Map<string, GeocodeHit | null>,
  keyOf: (address: string) => string
): { located: LocatedListing[]; unresolved: UnresolvedListing[] } {
  const located: LocatedListing[] = [];
  const unresolved: UnresolvedListing[] = [];

  for (const p of needGeocode) {
    const hit = results.get(keyOf(p.address));
    if (hit && usable(hit.lat) && usable(hit.lng)) {
      located.push({ ...p, lat: hit.lat, lng: hit.lng, coordinateSource: hit.method, coordinateConfidence: hit.confidence });
    } else {
      unresolved.push({
        externalId: p.externalId,
        address: p.address,
        reason: "No coordinates in the payload and the address could not be geocoded. Add latitude/longitude columns to the export, or correct the address.",
      });
    }
  }
  return { located, unresolved };
}

/**
 * Deduplicate points before spending a GIS request on them. Two listings in the
 * same building resolve to the same parcel, and a subdivision shares one zoning
 * district; rounding to ~1cm is far below any parcel boundary.
 *
 * Non-finite coordinates are dropped: proj4 turns NaN into NaN and ArcGIS
 * rejects the whole multipoint batch, taking the valid points down with it.
 */
export function distinctPoints(points: { lng: number; lat: number }[]): { lng: number; lat: number }[] {
  const seen = new Set<string>();
  const out: { lng: number; lat: number }[] = [];
  for (const p of points) {
    if (!Number.isFinite(p?.lng) || !Number.isFinite(p?.lat)) continue;
    const k = `${p.lng.toFixed(7)},${p.lat.toFixed(7)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

/** Counts for the refresh report, so interpolated pins are visible rather than implied. */
export function coordinateSummary(located: LocatedListing[], unresolved: UnresolvedListing[]) {
  const bySource: Record<string, number> = {};
  for (const l of located) bySource[l.coordinateSource] = (bySource[l.coordinateSource] ?? 0) + 1;
  return {
    provider: bySource.provider ?? 0,
    knownProperty: bySource.known_property ?? 0,
    addressPoint: (bySource.address_point ?? 0) + (bySource.address_point_fuzzy ?? 0),
    census: bySource.census ?? 0,
    unresolved: unresolved.length,
  };
}

/** One line for the refresh message. Empty when every row arrived with a pin. */
export function describeCoordinates(s: ReturnType<typeof coordinateSummary>): string {
  const parts: string[] = [];
  if (s.knownProperty) parts.push(`${s.knownProperty} reused a stored pin`);
  if (s.addressPoint) parts.push(`${s.addressPoint} geocoded from city address points`);
  // called out separately: interpolated, and deliberately not treated as surveyed
  if (s.census) parts.push(`${s.census} geocoded from the US Census (approximate)`);
  if (s.unresolved) parts.push(`${s.unresolved} could not be located and were skipped`);
  return parts.join(" · ");
}
