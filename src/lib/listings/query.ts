/**
 * The optional filter set for All Listings (spec §15, Phase 4).
 *
 * The hard acquisition filters in lib/filters.ts decide what enters the pool;
 * these are the operator's own narrowing controls on top. Pure parse + validate,
 * so bad query strings cannot reach the database and the UI, the API and the
 * saved-search payload all agree on one shape.
 *
 * Everything is optional. An absent filter means "do not narrow on this" —
 * never a silent default that quietly hides rows.
 */
export type SortKey =
  | "price_asc" | "price_desc" | "newest" | "oldest"
  | "price_drop" | "beds_desc" | "sqft_desc" | "ppsf_asc" | "dom_desc";

export type ListingFilters = {
  market: string;
  status: string[];            // active | pending | sold | removed
  minPrice: number | null;
  maxPrice: number | null;
  minBeds: number | null;
  maxBeds: number | null;
  minBaths: number | null;
  minSqft: number | null;
  maxSqft: number | null;
  minLotSqft: number | null;
  minYearBuilt: number | null;
  maxYearBuilt: number | null;
  propertyTypes: string[];
  zips: string[];
  hoaStatus: string[];         // VERIFIED_NO_HOA | HOA_PRESENT | HOA_UNKNOWN
  classification: string[];    // GREEN | YELLOW | RED
  zoneCodes: string[];
  pool: boolean | null;
  garage: boolean | null;
  basement: boolean | null;
  maxDaysOnMarket: number | null;
  priceDropOnly: boolean;
  screenedOnly: boolean;
  search: string | null;       // free text over address
  sort: SortKey;
  page: number;
  pageSize: number;
};

export const STATUSES = ["active", "pending", "sold", "removed"] as const;
export const CLASSIFICATIONS = ["GREEN", "YELLOW", "RED"] as const;
export const HOA_STATUSES = ["VERIFIED_NO_HOA", "HOA_PRESENT", "HOA_UNKNOWN"] as const;
export const SORTS: SortKey[] = ["price_asc", "price_desc", "newest", "oldest", "price_drop", "beds_desc", "sqft_desc", "ppsf_asc", "dom_desc"];

export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 50;

export const SORT_COLUMNS: Record<SortKey, { column: string; ascending: boolean; nullsFirst?: boolean }> = {
  price_asc:  { column: "list_price", ascending: true },
  price_desc: { column: "list_price", ascending: false },
  newest:     { column: "first_seen", ascending: false },
  oldest:     { column: "first_seen", ascending: true },
  price_drop: { column: "price_drop_pct", ascending: false },
  beds_desc:  { column: "beds", ascending: false },
  sqft_desc:  { column: "sqft", ascending: false },
  ppsf_asc:   { column: "price_per_sqft", ascending: true },
  dom_desc:   { column: "days_on_market", ascending: false },
};

type Params = { get(k: string): string | null } | Record<string, string | undefined>;

const read = (p: Params, k: string): string | null => {
  const v = typeof (p as any).get === "function" ? (p as any).get(k) : (p as any)[k];
  return v == null || v === "" ? null : String(v);
};

const int = (p: Params, k: string, min = -Infinity, max = Infinity): number | null => {
  const raw = read(p, k);
  if (raw == null) return null;
  const n = Number(raw.replace(/[^0-9.\-]/g, ""));
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
};

const flag = (p: Params, k: string): boolean | null => {
  const raw = read(p, k);
  if (raw == null) return null;
  if (/^(1|true|yes|y)$/i.test(raw)) return true;
  if (/^(0|false|no|n)$/i.test(raw)) return false;
  return null;
};

/** Comma-separated list, filtered to an allowed set when one is given. */
const list = (p: Params, k: string, allowed?: readonly string[], upper = false): string[] => {
  const raw = read(p, k);
  if (!raw) return [];
  const parts = raw.split(",").map((x) => (upper ? x.trim().toUpperCase() : x.trim())).filter(Boolean);
  const uniq = [...new Set(parts)];
  return allowed ? uniq.filter((x) => (allowed as readonly string[]).includes(x)) : uniq;
};

export function parseListingFilters(p: Params): ListingFilters {
  // A min above a max would return nothing and look like a bug; swap instead.
  let minPrice = int(p, "minPrice", 0);
  let maxPrice = int(p, "maxPrice", 0);
  if (minPrice != null && maxPrice != null && minPrice > maxPrice) [minPrice, maxPrice] = [maxPrice, minPrice];

  let minSqft = int(p, "minSqft", 0);
  let maxSqft = int(p, "maxSqft", 0);
  if (minSqft != null && maxSqft != null && minSqft > maxSqft) [minSqft, maxSqft] = [maxSqft, minSqft];

  let minYearBuilt = int(p, "minYearBuilt", 1600, 2100);
  let maxYearBuilt = int(p, "maxYearBuilt", 1600, 2100);
  if (minYearBuilt != null && maxYearBuilt != null && minYearBuilt > maxYearBuilt) [minYearBuilt, maxYearBuilt] = [maxYearBuilt, minYearBuilt];

  const sortRaw = read(p, "sort") as SortKey | null;
  const search = read(p, "q");

  return {
    market: read(p, "market") ?? "lexington-ky",
    status: list(p, "status", STATUSES),
    minPrice, maxPrice,
    minBeds: int(p, "minBeds", 0, 30),
    maxBeds: int(p, "maxBeds", 0, 30),
    minBaths: int(p, "minBaths", 0, 30),
    minSqft, maxSqft,
    minLotSqft: int(p, "minLotSqft", 0),
    minYearBuilt, maxYearBuilt,
    propertyTypes: list(p, "propertyType"),
    zips: list(p, "zip").filter((z) => /^\d{5}$/.test(z)),
    hoaStatus: list(p, "hoa", HOA_STATUSES, true),
    classification: list(p, "classification", CLASSIFICATIONS, true),
    zoneCodes: list(p, "zone", undefined, true),
    pool: flag(p, "pool"),
    garage: flag(p, "garage"),
    basement: flag(p, "basement"),
    maxDaysOnMarket: int(p, "maxDom", 0),
    priceDropOnly: flag(p, "priceDrop") === true,
    screenedOnly: flag(p, "screened") === true,
    search: search ? search.trim().slice(0, 120) : null,
    sort: sortRaw && SORTS.includes(sortRaw) ? sortRaw : "newest",
    page: Math.max(0, int(p, "page", 0) ?? 0),
    pageSize: Math.min(MAX_PAGE_SIZE, Math.max(1, int(p, "pageSize", 1) ?? DEFAULT_PAGE_SIZE)),
  };
}

/** Apply the filters to a PostgREST query builder over v_listings_enriched. */
export function applyListingFilters<T extends Record<string, any>>(q: T, f: ListingFilters): T {
  let b: any = q.eq("market_id", f.market);
  if (f.status.length) b = b.in("status", f.status);
  if (f.minPrice != null) b = b.gte("list_price", f.minPrice);
  if (f.maxPrice != null) b = b.lte("list_price", f.maxPrice);
  if (f.minBeds != null) b = b.gte("beds", f.minBeds);
  if (f.maxBeds != null) b = b.lte("beds", f.maxBeds);
  if (f.minBaths != null) b = b.gte("baths", f.minBaths);
  if (f.minSqft != null) b = b.gte("sqft", f.minSqft);
  if (f.maxSqft != null) b = b.lte("sqft", f.maxSqft);
  if (f.minLotSqft != null) b = b.gte("lot_sqft", f.minLotSqft);
  if (f.minYearBuilt != null) b = b.gte("year_built", f.minYearBuilt);
  if (f.maxYearBuilt != null) b = b.lte("year_built", f.maxYearBuilt);
  if (f.propertyTypes.length) b = b.in("property_type", f.propertyTypes);
  if (f.zips.length) b = b.in("zip", f.zips);
  if (f.hoaStatus.length) b = b.in("hoa_status", f.hoaStatus);
  if (f.classification.length) b = b.in("classification", f.classification);
  if (f.zoneCodes.length) b = b.in("zone_code", f.zoneCodes);
  if (f.pool != null) b = b.eq("pool", f.pool);
  if (f.garage != null) b = b.eq("garage", f.garage);
  if (f.basement != null) b = b.eq("basement", f.basement);
  if (f.maxDaysOnMarket != null) b = b.lte("days_on_market", f.maxDaysOnMarket);
  if (f.priceDropOnly) b = b.gt("price_drop", 0);
  if (f.screenedOnly) b = b.not("classification", "is", null);
  if (f.search) b = b.ilike("address", `%${f.search.replace(/[%,]/g, " ")}%`);

  const s = SORT_COLUMNS[f.sort];
  b = b.order(s.column, { ascending: s.ascending, nullsFirst: false });
  return b.range(f.page * f.pageSize, f.page * f.pageSize + f.pageSize - 1);
}

/** Human-readable chips for the active filters, so the UI states what is hidden. */
export function describeFilters(f: ListingFilters): string[] {
  const out: string[] = [];
  const money = (n: number) => `$${n.toLocaleString()}`;
  if (f.status.length) out.push(`status: ${f.status.join(", ")}`);
  if (f.minPrice != null && f.maxPrice != null) out.push(`${money(f.minPrice)}–${money(f.maxPrice)}`);
  else if (f.minPrice != null) out.push(`${money(f.minPrice)}+`);
  else if (f.maxPrice != null) out.push(`up to ${money(f.maxPrice)}`);
  if (f.minBeds != null) out.push(`${f.minBeds}+ bd`);
  if (f.maxBeds != null) out.push(`up to ${f.maxBeds} bd`);
  if (f.minBaths != null) out.push(`${f.minBaths}+ ba`);
  if (f.minSqft != null) out.push(`${f.minSqft.toLocaleString()}+ sqft`);
  if (f.maxSqft != null) out.push(`up to ${f.maxSqft.toLocaleString()} sqft`);
  if (f.minLotSqft != null) out.push(`lot ${f.minLotSqft.toLocaleString()}+ sqft`);
  if (f.minYearBuilt != null || f.maxYearBuilt != null) out.push(`built ${f.minYearBuilt ?? "any"}–${f.maxYearBuilt ?? "any"}`);
  if (f.propertyTypes.length) out.push(f.propertyTypes.join(", "));
  if (f.zips.length) out.push(`ZIP ${f.zips.join(", ")}`);
  if (f.hoaStatus.length) out.push(f.hoaStatus.join(", "));
  if (f.classification.length) out.push(f.classification.join(", "));
  if (f.zoneCodes.length) out.push(`zone ${f.zoneCodes.join(", ")}`);
  if (f.pool != null) out.push(f.pool ? "pool" : "no pool");
  if (f.garage != null) out.push(f.garage ? "garage" : "no garage");
  if (f.basement != null) out.push(f.basement ? "basement" : "no basement");
  if (f.maxDaysOnMarket != null) out.push(`≤ ${f.maxDaysOnMarket} days on market`);
  if (f.priceDropOnly) out.push("price reduced");
  if (f.screenedOnly) out.push("screened only");
  if (f.search) out.push(`“${f.search}”`);
  return out;
}
