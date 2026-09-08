/**
 * Sixgen portfolio + performance import (Phase 5).
 *
 * Two shapes, both produced by the Guesty export in `data/sixgen/`:
 *   properties  — one row per listing, with amenity flags
 *   monthly     — one row per listing-month
 *
 * Pure normalization; the route owns the writes. As everywhere else, a value
 * that cannot be read becomes null rather than a guess — a fabricated ADR here
 * would propagate into every forecast that used the listing as a comp.
 */
import { normalizeHeader, numOrNull } from "./columns";

export type SixgenPropertyRow = {
  guestyId: string | null;
  name: string;
  address: string | null;
  zip: string | null;
  lat: number | null;
  lng: number | null;
  beds: number | null;
  baths: number | null;
  maxGuests: number | null;
  propertyType: string | null;
  active: boolean;
  hotTub: boolean; golfSim: boolean; gameRoom: boolean;
  pool: boolean; firePit: boolean; poolTable: boolean;
  amenities: string[];
  errors: string[];
};

export type SixgenMonthlyRow = {
  guestyId: string | null;
  name: string;
  year: number;
  month: number;
  reservations: number | null;
  occupiedNights: number | null;
  availableNights: number | null;
  occupancy: number | null;
  adr: number | null;
  revpar: number | null;
  grossRevenue: number | null;
  errors: string[];
};

const val = (row: Record<string, string>, ...keys: string[]): string => {
  for (const k of keys) {
    const v = row[normalizeHeader(k)];
    if (v !== undefined && v !== "") return String(v).trim();
  }
  return "";
};

const truthy = (v: string): boolean => /^(true|t|yes|y|1)$/i.test(v.trim());

export function normalizeSixgenProperties(rows: Record<string, string>[]): { rows: SixgenPropertyRow[]; errors: string[] } {
  const out: SixgenPropertyRow[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  rows.forEach((row, i) => {
    const rowErrors: string[] = [];
    const name = val(row, "name", "listing", "title", "nickname");
    const guestyId = val(row, "guesty_id", "id", "listing_id") || null;
    if (!name && !guestyId) { errors.push(`Row ${i + 1}: no name or Guesty id — skipped.`); return; }

    const key = guestyId ?? name.toUpperCase();
    if (seen.has(key)) { errors.push(`Row ${i + 1}: duplicate listing "${name || guestyId}" — skipped.`); return; }
    seen.add(key);

    const beds = numOrNull(val(row, "beds", "bedrooms", "br"));
    if (beds == null) rowErrors.push("No bedroom count — this listing cannot be used as a comparable.");

    const tags = val(row, "tags");
    out.push({
      guestyId,
      name: name || guestyId!,
      address: val(row, "address", "full_address") || null,
      zip: (val(row, "zip", "zipcode", "postal_code").match(/\d{5}/)?.[0]) ?? null,
      lat: numOrNull(val(row, "lat", "latitude")),
      lng: numOrNull(val(row, "lng", "lon", "longitude")),
      beds,
      baths: numOrNull(val(row, "baths", "bathrooms")),
      maxGuests: numOrNull(val(row, "max_guests", "sleeps", "guests", "accommodates")),
      propertyType: val(row, "property_type", "type") || null,
      active: val(row, "active") === "" ? true : truthy(val(row, "active")),
      hotTub: truthy(val(row, "hot_tub", "hottub")),
      golfSim: truthy(val(row, "golf_sim", "golf_simulator")),
      gameRoom: truthy(val(row, "game_room", "gameroom")),
      pool: truthy(val(row, "pool")),
      firePit: truthy(val(row, "fire_pit", "firepit")),
      poolTable: truthy(val(row, "pool_table", "pooltable")),
      amenities: tags ? tags.split(/[;,|]/).map((t) => t.trim()).filter(Boolean) : [],
      errors: rowErrors,
    });
  });

  return { rows: out, errors };
}

export function normalizeSixgenMonthly(rows: Record<string, string>[]): { rows: SixgenMonthlyRow[]; errors: string[] } {
  const out: SixgenMonthlyRow[] = [];
  const errors: string[] = [];

  rows.forEach((row, i) => {
    const year = numOrNull(val(row, "year", "yr"));
    const month = numOrNull(val(row, "month", "mo"));
    const name = val(row, "name", "listing", "title");
    const guestyId = val(row, "guesty_id", "id", "listing_id") || null;

    if (year == null || month == null || month < 1 || month > 12) {
      errors.push(`Row ${i + 1}: unusable year/month (${val(row, "year")}/${val(row, "month")}) — skipped.`);
      return;
    }
    if (!name && !guestyId) { errors.push(`Row ${i + 1}: no listing identifier — skipped.`); return; }

    const occupied = numOrNull(val(row, "occupied_nights", "nights"));
    const available = numOrNull(val(row, "available_nights", "calendar_days"));
    const gross = numOrNull(val(row, "gross_revenue", "revenue", "host_payout"));
    let occupancy = numOrNull(val(row, "occupancy", "occ"));
    if (occupancy != null && occupancy > 1) occupancy = occupancy / 100;
    if (occupancy == null && occupied != null && available && available > 0) occupancy = +(occupied / available).toFixed(4);

    // A blank ADR on a month with no nights is correct, not missing data.
    let adr = numOrNull(val(row, "adr"));
    if (adr == null && gross != null && occupied && occupied > 0) adr = +(gross / occupied).toFixed(2);

    out.push({
      guestyId, name: name || guestyId!,
      year: Math.trunc(year), month: Math.trunc(month),
      reservations: numOrNull(val(row, "reservations", "bookings")),
      occupiedNights: occupied == null ? null : Math.trunc(occupied),
      availableNights: available == null ? null : Math.trunc(available),
      occupancy,
      adr,
      revpar: numOrNull(val(row, "revpar")),
      grossRevenue: gross,
      errors: [],
    });
  });

  return { rows: out, errors };
}

/** What the operator should be told before the import is used for forecasting. */
export function sixgenImportWarnings(props: SixgenPropertyRow[], monthly: SixgenMonthlyRow[]): string[] {
  const w: string[] = [];
  const noBeds = props.filter((p) => p.beds == null);
  if (noBeds.length) w.push(`${noBeds.length} listing${noBeds.length === 1 ? "" : "s"} have no bedroom count and cannot be used as comparables: ${noBeds.map((p) => p.name).slice(0, 5).join(", ")}.`);

  const known = new Set(props.map((p) => p.guestyId ?? p.name.toUpperCase()));
  const orphans = [...new Set(monthly.filter((m) => !known.has(m.guestyId ?? m.name.toUpperCase())).map((m) => m.name))];
  if (orphans.length) w.push(`${orphans.length} listing${orphans.length === 1 ? "" : "s"} appear in the monthly file but not the property file: ${orphans.slice(0, 5).join(", ")}.`);

  const zeroMonths = monthly.filter((m) => (m.occupiedNights ?? 0) === 0).length;
  if (zeroMonths) w.push(`${zeroMonths} of ${monthly.length} listing-months have no bookings. A listing that went live mid-window will show leading zeros that are not vacancy — the comp engine scales those listings down rather than averaging the zeros in.`);

  const byListing = new Map<string, number>();
  for (const m of monthly) byListing.set(m.name, (byListing.get(m.name) ?? 0) + 1);
  const thin = [...byListing.entries()].filter(([, n]) => n < 12).map(([n]) => n);
  if (thin.length) w.push(`${thin.length} listing${thin.length === 1 ? "" : "s"} have fewer than 12 months of history: ${thin.slice(0, 5).join(", ")}.`);

  return w;
}

// ── re-import change detection ───────────────────────────────────────────────
/**
 * Monthly rows are appended under a new import_id so a corrected export never
 * overwrites history, and the comp engine reads the newest reading per
 * listing-month. That is right when something changed — and pure waste when
 * nothing did. Re-running the same unchanged export wrote another full
 * generation every time: 408 rows carrying no new information, three times over,
 * until they were pruned by hand. The `imports` table already records that the
 * run happened; duplicating the measurements does not add to that.
 *
 * So compare against the newest reading already stored and write only what
 * actually differs.
 */
export type MonthlyMetrics = {
  reservations: number | null; occupied_nights: number | null; available_nights: number | null;
  occupancy: number | null; adr: number | null; revpar: number | null; gross_revenue: number | null;
};

export const monthlyKey = (propertyId: number, year: number, month: number) => `${propertyId}|${year}|${month}`;

/** Postgres numerics arrive as strings; compare as numbers, at the precision stored. */
const same = (a: unknown, b: unknown): boolean => {
  if (a == null || b == null) return a == null && b == null;
  const [x, y] = [Number(a), Number(b)];
  if (!Number.isFinite(x) || !Number.isFinite(y)) return String(a) === String(b);
  return Math.abs(x - y) < 1e-6;
};

const FIELDS: (keyof MonthlyMetrics)[] = [
  "reservations", "occupied_nights", "available_nights", "occupancy", "adr", "revpar", "gross_revenue",
];

export function sameMonthlyReading(a: Partial<MonthlyMetrics>, b: Partial<MonthlyMetrics>): boolean {
  return FIELDS.every((f) => same(a[f], b[f]));
}

/**
 * The subset of `payload` worth writing: rows with no stored reading, and rows
 * whose numbers differ from the newest one held.
 */
export function changedMonthlyRows<T extends MonthlyMetrics & { sixgen_property_id: number; year: number; month: number }>(
  payload: T[],
  newest: Map<string, Partial<MonthlyMetrics>>,
): T[] {
  return payload.filter((row) => {
    const current = newest.get(monthlyKey(row.sixgen_property_id, row.year, row.month));
    return !current || !sameMonthlyReading(row, current);
  });
}
