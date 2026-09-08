/**
 * RESO Web API (OData) adapter — Spark / flexmls and anything else RESO-compliant.
 *
 * Written against the RESO Data Dictionary rather than Spark's native API so the
 * same adapter carries to the next market. Spark serves both; ask the MLS for
 * the RESO endpoint.
 *
 * The mapping is deliberately separate from the fetching. Every MLS deviates
 * from the dictionary somewhere, and the mapping is the part that will need
 * correcting once we see ImagineMLS's actual payload — so it is a pure function
 * with tests, not something buried in a request loop.
 *
 * Two honesty rules are enforced here rather than left to the caller:
 *
 *  1. `AssociationYN: false` is the listing agent's claim, not a title search.
 *     It is passed as a *flag*, never as `verified`, so `hoaStatusFrom` resolves
 *     it to HOA_UNKNOWN rather than VERIFIED_NO_HOA. An HOA can forbid
 *     short-term rental regardless of zoning, so a wrong "no HOA" is expensive.
 *
 *  2. `AssociationFee` carries a *frequency*. A $1,200 annual fee and a $1,200
 *     monthly fee are the same number in the field and a 12x difference in the
 *     pro forma. Anything we cannot convert becomes null, not a guess.
 */
import type { ParsedListing } from "./listings";
import { hoaStatusFrom } from "../filters";
import { parseAddress } from "../address";

export type ResoConfig = {
  baseUrl: string;
  token: string;
  /** OData resource; Property for listings. */
  resource?: string;
  /** $filter applied server-side. Defaults to active residential. */
  filter?: string;
  /** Rows per page. Most servers cap this; the nextLink is followed regardless. */
  pageSize?: number;
  /** Hard ceiling so a misconfigured filter cannot pull the entire MLS. */
  maxRows?: number;
};

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const bool = (v: unknown): boolean | null => {
  if (v === true || v === false) return v;
  if (v == null || v === "") return null;
  const s = String(v).trim().toLowerCase();
  if (s === "true" || s === "yes" || s === "y" || s === "1") return true;
  if (s === "false" || s === "no" || s === "n" || s === "0") return false;
  return null;
};

const isoDate = (v: unknown): string | null => {
  if (!v) return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

/**
 * Association fees to a monthly figure.
 *
 * RESO's AssociationFeeFrequency is an enumerated string. An unrecognized value
 * returns null rather than assuming monthly: understating a $400/mo fee as
 * $400/yr flatters the pro forma by ~$4,400 a year, which is the kind of error
 * that survives review because the number looks reasonable.
 */
export function monthlyFee(fee: unknown, frequency: unknown): number | null {
  const f = num(fee);
  if (f == null || f <= 0) return null;
  const per: Record<string, number> = {
    monthly: 1, month: 1,
    annually: 12, annual: 12, yearly: 12, year: 12,
    quarterly: 3, quarter: 3,
    "semi-annually": 6, semiannually: 6, semiannual: 6, biannually: 6,
    "bi-monthly": 2, bimonthly: 2,
    weekly: 1 / (52 / 12), biweekly: 2 / (52 / 12),
    "one time": 0, onetime: 0, "one-time": 0,
  };
  const key = String(frequency ?? "").trim().toLowerCase();
  if (!key) return null;                       // a fee with no period is not a monthly figure
  const divisor = per[key];
  if (divisor === undefined) return null;      // unknown cadence — say nothing
  if (divisor === 0) return null;              // a one-time fee is not a carrying cost
  return +(f / divisor).toFixed(2);
}

/**
 * RESO StandardStatus to the four states the pipeline understands.
 * An unrecognized status maps to `removed` — the conservative direction, since
 * treating an unknown state as `active` would put it in front of you as buyable.
 */
export function mapStatus(standardStatus: unknown): string {
  const s = String(standardStatus ?? "").trim().toLowerCase();
  if (/^active$/.test(s) || s === "coming soon" || s === "active under contract") {
    return s === "active under contract" ? "pending" : "active";
  }
  if (/pending|contingent/.test(s)) return "pending";
  if (/closed|sold/.test(s)) return "sold";
  if (/withdrawn|expired|canceled|cancelled|hold|delete/.test(s)) return "removed";
  return "removed";
}

/** Bathrooms: prefer the total, else compose from full + half. */
function baths(r: Record<string, any>): number | null {
  const total = num(r.BathroomsTotalInteger) ?? num(r.BathroomsTotalDecimal) ?? num(r.BathroomsFull1);
  if (total != null) return total;
  const full = num(r.BathroomsFull), half = num(r.BathroomsHalf);
  if (full == null && half == null) return null;
  return (full ?? 0) + (half ?? 0) * 0.5;
}

/** Address: prefer UnparsedAddress, else compose from the parts. */
function address(r: Record<string, any>): string | null {
  const un = String(r.UnparsedAddress ?? "").trim();
  if (un) return un;
  const parts = [r.StreetNumber, r.StreetDirPrefix, r.StreetName, r.StreetSuffix, r.StreetDirSuffix]
    .map((x) => String(x ?? "").trim()).filter(Boolean);
  const line = parts.join(" ").trim();
  return line || null;
}

/**
 * One RESO Property record to the shape the refresh engine consumes.
 * Returns null when there is no address — nothing downstream can identify it.
 */
export function resoToListing(r: Record<string, any>): ParsedListing | null {
  const addr = address(r);
  if (!addr) return null;

  // ListingKey is the stable system identifier; ListingId is the MLS number the
  // agent quotes and can be reused across relistings. Identity here feeds the
  // diff, so it has to be the stable one — the MLS number stays in `raw`.
  const externalId = String(r.ListingKey ?? r.ListingId ?? "").trim();
  if (!externalId) return null;

  const parsed = parseAddress(addr);
  const unit = String(r.UnitNumber ?? "").trim() || parsed.unit || null;

  const lotSqft = num(r.LotSizeSquareFeet)
    ?? (num(r.LotSizeAcres) != null ? Math.round(num(r.LotSizeAcres)! * 43560) : null);

  return {
    externalId,
    address: addr,
    addressNorm: parsed.normalized || addr.toUpperCase().replace(/\s+/g, " ").trim(),
    unit,
    zip: String(r.PostalCode ?? "").trim() || parsed.zip || null,
    lat: num(r.Latitude),
    lng: num(r.Longitude),
    price: num(r.ListPrice),
    originalPrice: num(r.OriginalListPrice),
    beds: num(r.BedroomsTotal),
    baths: baths(r),
    sqft: num(r.LivingArea),
    lotSqft,
    yearBuilt: num(r.YearBuilt),
    propertyType: String(r.PropertySubType ?? r.PropertyType ?? "").trim() || null,
    stories: num(r.StoriesTotal),
    garage: bool(r.GarageYN) ?? (num(r.GarageSpaces) != null ? num(r.GarageSpaces)! > 0 : null),
    pool: bool(r.PoolPrivateYN),
    basement: bool(r.BasementYN) ?? (Array.isArray(r.Basement) ? r.Basement.length > 0 : null),
    finishedBasement: null,          // no dictionary field carries this reliably
    // `verified` is deliberately never set from a feed: the listing agent's
    // AssociationYN is a claim, and VERIFIED_NO_HOA must come from a deed search.
    hoaStatus: hoaStatusFrom({
      fee: monthlyFee(r.AssociationFee, r.AssociationFeeFrequency),
      flag: bool(r.AssociationYN),
      verified: false,
    }),
    hoaFeeMonthly: monthlyFee(r.AssociationFee, r.AssociationFeeFrequency),
    hoaName: String(r.AssociationName ?? "").trim() || null,
    daysOnMarket: num(r.DaysOnMarket) ?? num(r.CumulativeDaysOnMarket),
    listedAt: isoDate(r.OnMarketDate ?? r.ListingContractDate),
    status: mapStatus(r.StandardStatus ?? r.MlsStatus),
    url: String(r.ListingURL ?? "").trim() || null,
    primaryPhoto: Array.isArray(r.Media) && r.Media.length
      ? String(r.Media[0]?.MediaURL ?? "").trim() || null
      : null,
    description: String(r.PublicRemarks ?? "").trim() || null,
    brokerage: String(r.ListOfficeName ?? "").trim() || null,
    agent: String(r.ListAgentFullName ?? "").trim() || null,
    raw: { ...r, MlsNumber: r.ListingId ?? null },
  };
}

const DEFAULT_FILTER = "StandardStatus eq 'Active' and PropertyType eq 'Residential'";

/**
 * Fetch every page the filter matches, following OData's `@odata.nextLink`.
 *
 * `maxRows` is a guard, not a preference: a filter typo that matches the whole
 * MLS should stop early and say so, rather than quietly pulling six figures of
 * rows and looking like it worked.
 */
export async function fetchResoListings(
  cfg: ResoConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<{ rows: Record<string, any>[]; pages: number; truncated: boolean }> {
  const resource = cfg.resource ?? "Property";
  const pageSize = cfg.pageSize ?? 200;
  const maxRows = cfg.maxRows ?? 5000;

  const url = new URL(`${cfg.baseUrl.replace(/\/+$/, "")}/${resource}`);
  url.searchParams.set("$filter", cfg.filter ?? DEFAULT_FILTER);
  url.searchParams.set("$top", String(pageSize));

  const rows: Record<string, any>[] = [];
  let next: string | null = url.toString();
  let pages = 0;

  while (next && rows.length < maxRows) {
    const res: Response = await fetchImpl(next, {
      headers: { Authorization: `Bearer ${cfg.token}`, Accept: "application/json" },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`RESO ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 300)}` : ""}`);
    }
    const json: any = await res.json();
    const page: Record<string, any>[] = json.value ?? [];
    rows.push(...page);
    pages++;
    next = json["@odata.nextLink"] ?? null;
    if (!page.length) break;                 // a server that pages forever cannot hang us
  }

  // Truncated means "the server had more and we stopped", which is what the
  // caller must refuse. Comparing lengths alone misses it: the loop exits
  // exactly AT the ceiling, so rows.length is never greater than maxRows and a
  // partial pull would report itself complete — the one outcome this guard is
  // here to prevent. The live signal is a nextLink still outstanding.
  const moreRemained = next != null && rows.length >= maxRows;
  return { rows: rows.slice(0, maxRows), pages, truncated: moreRemained };
}
