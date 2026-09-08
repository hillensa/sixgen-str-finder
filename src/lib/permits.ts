/**
 * INVARIANT: every permitted STR is always shown on the map.
 *
 * Bedroom / price / HOA filters exist ONLY for for-sale listings (see filters.ts).
 * Permits are never filtered by size, value, type, or status for display —
 * only their *blocking* flag (un-hosted, active) changes how they're drawn and
 * whether they count toward the separation rule.
 *
 * tests/permits.test.ts guards this: it fails the build if any module that
 * touches str_permits also imports the acquisition filters, and it asserts
 * mapPermits() returns 100% of its input.
 */
export type PermitRow = {
  id: number; address_norm: string | null; address_raw: string | null;
  str_type: string | null; permit_status: string | null; is_blocking: boolean | null;
  lat: number | null; lng: number | null; source: string | null; match_confidence: number | null;
  unit?: string | null; blocking_reason?: string | null; match_status?: string | null;
  geocode_method?: string | null; review_note?: string | null;
};

export type MapPermit = PermitRow & { display: "blocking" | "hosted" | "unknown" | "unlocated" };

/** Pass-through classification for display. Never drops a row. */
export function mapPermits(rows: PermitRow[]): MapPermit[] {
  return rows.map((p) => ({
    ...p,
    display:
      p.lat == null || p.lng == null ? "unlocated"
      : p.is_blocking ? "blocking"
      : p.str_type === "hosted" ? "hosted"
      : "unknown",
  }));
}

/** Summary counts for the layer label — derived from the full set. */
export function permitCounts(rows: MapPermit[]) {
  const c = { total: rows.length, blocking: 0, hosted: 0, unknown: 0, unlocated: 0 };
  for (const r of rows) c[r.display]++;
  return c;
}
