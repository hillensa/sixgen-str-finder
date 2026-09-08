/**
 * Provider-independent Listings Data Service (spec §11).
 * Swap providers by changing LISTINGS_PROVIDER; the rest of the app never
 * touches provider specifics. No scraping, no access-control circumvention.
 */
import type { HoaStatus } from "../types";
import { hoaStatusFrom } from "../filters";
import { parseAddress } from "../address";

export type NormalizedListing = {
  externalId: string;
  address: string;
  /** Canonical form used to match a listing to one property. */
  addressNorm: string;
  unit?: string | null;
  zip?: string | null;
  lat: number; lng: number;
  price: number | null; originalPrice?: number | null;
  beds: number | null; baths?: number | null; sqft?: number | null; lotSqft?: number | null;
  yearBuilt?: number | null; propertyType?: string | null; stories?: number | null;
  garage?: boolean | null; pool?: boolean | null; basement?: boolean | null; finishedBasement?: boolean | null;
  hoaStatus: HoaStatus; hoaFeeMonthly?: number | null; hoaName?: string | null;
  daysOnMarket?: number | null; listedAt?: string | null; status: string;
  url?: string | null; primaryPhoto?: string | null; description?: string | null;
  brokerage?: string | null; agent?: string | null;
  raw?: any;
};

/**
 * A listing whose coordinates are not settled yet.
 *
 * MLS exports frequently omit latitude/longitude — flexmls carries them, but
 * they are not in a default export view, so a perfectly good CSV arrives with
 * every other field and no pin. These rows used to be dropped silently inside
 * `normalizeRow`, which meant an agent's export could lose half its rows with
 * nothing to show for it. The provider now surfaces them and `runRefresh`
 * resolves the coordinate before anything is written.
 *
 * `properties.lat/lng` are NOT NULL for a reason: a property with no pin cannot
 * be tested against the 600-ft exclusion, and a row that cannot be screened must
 * never reach the pipeline. So this type exists only between parse and geocode.
 */
export type ParsedListing = Omit<NormalizedListing, "lat" | "lng"> & {
  lat: number | null;
  lng: number | null;
};

export interface ListingsProvider {
  readonly id: string;
  /**
   * Full active set for a market. Rows may arrive without coordinates; the
   * refresh engine geocodes them, since it holds the db handle the cache needs.
   */
  searchListings(marketId: string, opts?: { input?: string }): Promise<ParsedListing[]>;
  getListing?(externalId: string): Promise<NormalizedListing | null>;
  /** Optional incremental changes since a timestamp (providers that support it). */
  getListingChanges?(marketId: string, since: Date): Promise<NormalizedListing[]>;
}

// ---------------- CSV provider (launch fallback) ----------------
const HEADER_ALIASES: Record<string, string[]> = {
  externalId: ["id", "listing_id", "listingid", "mls", "mls_number", "mlsnumber", "zpid"],
  address: ["address", "street_address", "full_address", "property_address"],
  zip: ["zip", "zipcode", "postal_code", "zip_code"],
  lat: ["lat", "latitude"], lng: ["lng", "lon", "long", "longitude"],
  price: ["price", "list_price", "listprice", "asking_price"],
  originalPrice: ["original_price", "originalprice", "orig_price"],
  beds: ["beds", "bedrooms", "br", "bd"], baths: ["baths", "bathrooms", "ba"],
  sqft: ["sqft", "square_feet", "living_area", "area"], lotSqft: ["lot_sqft", "lot_size_sqft", "lotsize"],
  yearBuilt: ["year_built", "yearbuilt", "built"], propertyType: ["property_type", "type", "home_type"],
  stories: ["stories", "levels"], garage: ["garage"], pool: ["pool"], basement: ["basement"], finishedBasement: ["finished_basement"],
  hoa: ["hoa", "has_hoa"], hoaVerified: ["hoa_verified", "hoa_confirmed"], unit: ["unit", "apt", "suite"],
  hoaFeeMonthly: ["hoa_fee", "hoa_monthly", "hoa_fee_monthly", "association_fee"], hoaName: ["hoa_name", "association_name"],
  daysOnMarket: ["dom", "days_on_market", "daysonmarket"], listedAt: ["listed_at", "list_date", "listing_date"],
  status: ["status", "listing_status", "mls_status"], url: ["url", "listing_url", "link"],
  primaryPhoto: ["photo", "primary_photo", "image", "img"], description: ["description", "remarks", "public_remarks"],
  brokerage: ["brokerage", "office", "listing_office"], agent: ["agent", "listing_agent"],
};

export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []; let cur: string[] = []; let field = ""; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === ",") { cur.push(field); field = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; cur.push(field); rows.push(cur); cur = []; field = ""; }
    else field += c;
  }
  if (field.length || cur.length) { cur.push(field); rows.push(cur); }
  const [hdr, ...body] = rows.filter((r) => r.some((x) => x.trim() !== ""));
  if (!hdr) return [];
  const keys = hdr.map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""));
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}

function pick(row: Record<string, string>, field: string): string | undefined {
  for (const a of HEADER_ALIASES[field] ?? [field]) if (row[a] !== undefined && row[a] !== "") return row[a];
  return undefined;
}
const num = (v?: string) => { if (v == null || v === "") return null; const n = Number(String(v).replace(/[^0-9.\-]/g, "")); return Number.isFinite(n) ? n : null; };

/**
 * Tri-state boolean. The old two-state version returned `false` for anything it
 * did not recognise, so a CSV carrying "unknown", "N/A" or "-" read as a hard
 * NO. For HOA that meant asserting VERIFIED_NO_HOA on no evidence at all.
 * Unrecognized input is now `null` — we do not know.
 */
const bool = (v?: string): boolean | null => {
  const s = String(v ?? "").trim();
  if (!s) return null;
  if (/^(y|yes|true|t|1)$/i.test(s)) return true;
  if (/^(n|no|false|f|0)$/i.test(s)) return false;
  return null;
};

/** A calendar date, or null. Never hands an unparseable string to Postgres. */
const isoDate = (v?: string): string | null => {
  const s = String(v ?? "").trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const us = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (us) {
    const yr = us[3].length === 2 ? Number(us[3]) + 2000 : Number(us[3]);
    const d = new Date(Date.UTC(yr, Number(us[1]) - 1, Number(us[2])));
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

/**
 * Parse one row. Coordinates are optional here — an address is not.
 *
 * Returns null only when there is nothing to identify the property by, because
 * without an address there is neither a pin nor anything to geocode.
 */
export function parseListingRow(row: Record<string, string>): ParsedListing | null {
  const lat = num(pick(row, "lat")), lng = num(pick(row, "lng"));
  const address = pick(row, "address");
  if (!address) return null;
  // A provider field is a claim, not a verification. `hoaStatusFrom` only
  // returns VERIFIED_NO_HOA when an explicit hoa_verified column vouches for it;
  // a bare "false" or a $0 fee leaves the status HOA_UNKNOWN, which is what the
  // eligibility engine then reports.
  const hoaFee = num(pick(row, "hoaFeeMonthly"));
  const hoaStatus = hoaStatusFrom({
    fee: hoaFee,
    flag: bool(pick(row, "hoa")),
    verified: bool(pick(row, "hoaVerified")) === true,
  });
  const statusRaw = (pick(row, "status") ?? "active").toLowerCase();
  const parsed = parseAddress(address);
  const addressNorm = parsed.normalized || address.toUpperCase().replace(/\s+/g, " ").trim();
  // The unit column and a unit embedded in the address string are the same
  // fact. Resolve it once: the address-derived identity below has to include it,
  // or 697 Cindy Blair Way #1 and #2 collapse into one listing.
  const unit = pick(row, "unit") || parsed.unit || null;
  return {
    // A file with no id column gets a synthetic one. Coordinates remain the key
    // when the payload has them, so ids stay stable across re-imports of the
    // same export; only a row that arrived without a pin falls back to the
    // address, which is the identity the property matcher uses anyway.
    externalId: pick(row, "externalId")
      ?? (lat != null && lng != null
        ? `${lat.toFixed(6)},${lng.toFixed(6)}`
        : `${addressNorm}${unit ? `#${unit}` : ""}`),
    address,
    addressNorm,
    unit,
    zip: pick(row, "zip") ?? parsed.zip ?? (address.match(/\b(\d{5})\b\s*$/)?.[1] ?? null),
    lat, lng, price: num(pick(row, "price")), originalPrice: num(pick(row, "originalPrice")),
    beds: num(pick(row, "beds")), baths: num(pick(row, "baths")), sqft: num(pick(row, "sqft")), lotSqft: num(pick(row, "lotSqft")),
    yearBuilt: num(pick(row, "yearBuilt")), propertyType: pick(row, "propertyType") ?? null, stories: num(pick(row, "stories")),
    garage: bool(pick(row, "garage")), pool: bool(pick(row, "pool")), basement: bool(pick(row, "basement")), finishedBasement: bool(pick(row, "finishedBasement")),
    hoaStatus, hoaFeeMonthly: hoaFee, hoaName: pick(row, "hoaName") ?? null,
    daysOnMarket: num(pick(row, "daysOnMarket")),
    // Validated, not passed through. A ragged CSV row shifts columns left and
    // sends something like "active" into this field; unvalidated it reaches
    // Postgres as a date literal and 500s the whole import mid-write.
    listedAt: isoDate(pick(row, "listedAt")),
    status: /sold|closed/.test(statusRaw) ? "sold" : /pend|contingent/.test(statusRaw) ? "pending" : /withdrawn|expired|cancel/.test(statusRaw) ? "removed" : "active",
    url: pick(row, "url") ?? null, primaryPhoto: pick(row, "primaryPhoto") ?? null, description: pick(row, "description") ?? null,
    brokerage: pick(row, "brokerage") ?? null, agent: pick(row, "agent") ?? null, raw: row,
  };
}

/**
 * Parse one row and insist on coordinates.
 *
 * Kept for callers that genuinely cannot geocode — anything holding a db handle
 * should use `parseListingRow` and let the refresh engine resolve the pin.
 */
export function normalizeRow(row: Record<string, string>): NormalizedListing | null {
  const p = parseListingRow(row);
  if (!p || p.lat == null || p.lng == null) return null;
  return { ...p, lat: p.lat, lng: p.lng };
}

export class CsvProvider implements ListingsProvider {
  readonly id = "csv";
  async searchListings(_marketId: string, opts?: { input?: string }) {
    if (!opts?.input) return [];
    return parseCsv(opts.input).map(parseListingRow).filter((x): x is ParsedListing => !!x);
  }
}

/** JSON array of NormalizedListing-ish objects (also accepts the legacy {zpid,lat,lng,...} shape). */
export class JsonProvider implements ListingsProvider {
  readonly id = "json";
  async searchListings(_marketId: string, opts?: { input?: string }) {
    if (!opts?.input) return [];
    const parsed = JSON.parse(opts.input);
    const arr: any[] = Array.isArray(parsed) ? parsed : parsed.listings ?? [];
    return arr.map((o) => parseListingRow(Object.fromEntries(Object.entries({
      id: o.externalId ?? o.zpid ?? o.id, address: o.address, lat: o.lat, lng: o.lng, price: o.price, beds: o.beds, baths: o.baths, sqft: o.sqft,
      hoa_fee: o.hoaFeeMonthly ?? o.hoa,
      // the JSON shape states the tri-state outright, so VERIFIED_NO_HOA here
      // really is a verification claim and carries hoa_verified with it
      hoa: o.hoaStatus === "HOA_PRESENT" ? "true" : o.hoaStatus === "VERIFIED_NO_HOA" ? "false" : undefined,
      hoa_verified: o.hoaStatus === "VERIFIED_NO_HOA" || o.hoaStatus === "HOA_PRESENT" ? "true" : undefined,
      unit: o.unit,
      status: o.status, url: o.url, photo: o.primaryPhoto,
    }).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])))).filter((x): x is ParsedListing => !!x);
  }
}

/** Placeholder for an authorized RESO Web API feed (Phase 4+). Throws until configured. */
export class ResoWebApiProvider implements ListingsProvider {
  readonly id = "reso";
  constructor(private baseUrl = process.env.RESO_API_URL, private token = process.env.RESO_API_TOKEN) {}
  async searchListings(): Promise<NormalizedListing[]> {
    if (!this.baseUrl || !this.token) throw new Error("RESO provider not configured (RESO_API_URL / RESO_API_TOKEN)");
    throw new Error("RESO adapter scheduled for Phase 4 once MLS credentials are issued");
  }
}

export function getProvider(id = process.env.LISTINGS_PROVIDER ?? "csv"): ListingsProvider {
  switch (id) { case "json": return new JsonProvider(); case "reso": return new ResoWebApiProvider(); default: return new CsvProvider(); }
}
