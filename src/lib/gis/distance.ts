/**
 * Straight-line distance between two WGS84 points, in feet.
 *
 * This is NOT the regulatory measurement. LFUCG's 600 ft is measured property
 * line to property line, which needs the parcel polygons and is computed in
 * PostGIS by `fn_spacing_test`. That function also stops looking at the rule
 * distance, so a passing address reports no nearest-STR distance at all — which
 * is why "how close am I to the nearest STRs?" could not be answered from it.
 *
 * What this gives instead is the house-to-house distance: the question an
 * operator actually asks when sizing up a street. Every caller must label it as
 * such so it is never mistaken for the screening result.
 */
export type GeoPoint = { lat: number; lng: number };

const EARTH_RADIUS_FT = 20_902_231;

export function distanceFt(a: GeoPoint, b: GeoPoint): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const p1 = toRad(a.lat), p2 = toRad(b.lat);
  const dp = p2 - p1, dl = toRad(b.lng - a.lng);
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_RADIUS_FT * Math.asin(Math.min(1, Math.sqrt(h)));
}

export type NearbyPermit<T> = T & { distance_ft: number };

/**
 * The `limit` permits closest to `subject`, nearest first.
 *
 * Permits with no coordinates are skipped rather than sorted to one end: an
 * un-geocoded permit has an unknown distance, and showing it as nearest or
 * furthest would both be claims the data does not support. Callers report the
 * skipped count so the omission is visible.
 */
export function nearestPermits<T extends { lat: number | null; lng: number | null }>(
  subject: GeoPoint,
  permits: T[],
  limit = 8,
): { nearest: NearbyPermit<T>[]; located: number; unlocated: number } {
  const located = permits.filter((p) => p.lat != null && p.lng != null);
  const scored = located.map((p) => ({
    ...p,
    distance_ft: Math.round(distanceFt(subject, { lat: p.lat as number, lng: p.lng as number })),
  }));
  scored.sort((a, b) => a.distance_ft - b.distance_ft);
  return {
    nearest: scored.slice(0, limit),
    located: located.length,
    unlocated: permits.length - located.length,
  };
}
