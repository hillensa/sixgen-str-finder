/**
 * What the "Send to Sixgen" bookmark copies off a Zillow results page, and the
 * checks it passes before any of it reaches the database.
 *
 * The bookmark runs in Seth's own browser on a page he opened himself, so it
 * never meets Zillow's bot protection. Everything in the payload is still
 * treated as untrusted text: it arrives through the clipboard, and anything can
 * be pasted.
 */
import { filterSignature, type ZillowCriteria } from "./criteria";

export const PAYLOAD_MARKER = "zillow-pull";
export const COMPLETE_RATIO = 0.95;
const MAX_HOMES = 2000;

export type ZillowHome = {
  zpid: string; address: string; zip: string | null;
  lat: number; lng: number; price: number | null;
  beds: number | null; baths: number | null; sqft: number | null; lotSqft: number | null;
  homeType: string | null; dom: number | null; photo: string | null;
};

export type ZillowPayload = {
  sixgen: typeof PAYLOAD_MARKER; v: 1;
  signature: string | null;        // the filters the Zillow page itself reported
  total: number | null; totalPages: number | null;
  pages: number[];
  homes: ZillowHome[];
};

const PHOTO_HOST = /^https:\/\/photos\.zillowstatic\.com\/fp\/[0-9a-f]+-[a-z_]+\.(jpg|webp)$/;
const n = (v: unknown) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * Parse pasted text into a payload, or say why it is not one. Rows that are
 * malformed are dropped and counted rather than failing the whole paste.
 */
export function parsePayload(text: string): { ok: true; value: ZillowPayload; dropped: number } | { ok: false; error: string } {
  let o: any;
  try { o = JSON.parse(text); } catch { return { ok: false, error: "That isn't something the Send to Sixgen bookmark copied." }; }
  if (o?.sixgen !== PAYLOAD_MARKER || o?.v !== 1 || !Array.isArray(o?.homes)) {
    return { ok: false, error: "That isn't something the Send to Sixgen bookmark copied." };
  }
  if (o.homes.length > MAX_HOMES) return { ok: false, error: `More than ${MAX_HOMES} homes in one paste — refusing.` };

  let dropped = 0;
  const homes: ZillowHome[] = [];
  for (const h of o.homes) {
    const zpid = String(h?.zpid ?? "");
    const lat = n(h?.lat), lng = n(h?.lng);
    const address = typeof h?.address === "string" ? h.address.trim().slice(0, 200) : "";
    // Coordinates must land in or near Fayette County; anything else is not a
    // Lexington listing, whatever the page claimed.
    if (!/^\d{1,12}$/.test(zpid) || !address || lat == null || lng == null
        || lat < 37.7 || lat > 38.4 || lng < -84.9 || lng > -84.1) { dropped++; continue; }
    const photo = typeof h?.photo === "string" && PHOTO_HOST.test(h.photo) ? h.photo : null;
    homes.push({
      zpid, address, zip: typeof h?.zip === "string" ? h.zip.slice(0, 10) : null,
      lat, lng, price: n(h?.price), beds: n(h?.beds), baths: n(h?.baths), sqft: n(h?.sqft),
      lotSqft: n(h?.lotSqft), homeType: typeof h?.homeType === "string" ? h.homeType.slice(0, 40) : null,
      dom: n(h?.dom), photo,
    });
  }
  const pages = Array.isArray(o.pages) ? [...new Set<number>(o.pages.map(Number).filter((p: number) => Number.isInteger(p) && p > 0))].sort((a, b) => a - b) : [];
  return {
    ok: true, dropped,
    value: {
      sixgen: PAYLOAD_MARKER, v: 1,
      signature: typeof o.signature === "string" ? o.signature : null,
      total: n(o.total), totalPages: n(o.totalPages), pages, homes,
    },
  };
}

/** Fold a newly pasted page into what has been collected so far. */
export function mergePayloads(a: ZillowPayload | null, b: ZillowPayload): ZillowPayload {
  // A different search is a fresh start, not more pages of the old one.
  if (!a || a.signature !== b.signature) return b;
  const byId = new Map(a.homes.map((h) => [h.zpid, h]));
  for (const h of b.homes) byId.set(h.zpid, h);
  return {
    ...b,
    pages: [...new Set([...a.pages, ...b.pages])].sort((x, y) => x - y),
    homes: [...byId.values()],
  };
}

/**
 * A pull is complete only if every page was collected and the homes add up to
 * nearly Zillow's own total. Only a complete pull may full-sync: a full sync of
 * a partial set retires every home on the pages that were missed.
 */
export function isComplete(p: ZillowPayload): boolean {
  if (!p.total || !p.totalPages) return false;
  for (let i = 1; i <= p.totalPages; i++) if (!p.pages.includes(i)) return false;
  return p.homes.length >= COMPLETE_RATIO * p.total;
}

/** Split homes into those that meet the saved criteria and those that do not. */
export function applyCriteria(homes: ZillowHome[], c: ZillowCriteria) {
  const kept: ZillowHome[] = [], rejected: ZillowHome[] = [];
  for (const h of homes) ((h.beds ?? 0) >= c.bedsMin && (h.baths ?? 0) >= c.bathsMin ? kept : rejected).push(h);
  return { kept, rejected };
}

/** Did the Zillow page use the filters Sixgen has saved? */
export function matchesCriteria(p: ZillowPayload, c: ZillowCriteria): boolean {
  return p.signature === filterSignature(c);
}

const TYPE: Record<string, string> = {
  SINGLE_FAMILY: "SF", CONDO: "Condo", TOWNHOUSE: "Townhouse",
  MULTI_FAMILY: "Multi-family", MANUFACTURED: "Manufactured", LOT: "Lot",
};

/** The CSV the existing refresh path already understands. */
export function toImportCsv(homes: ZillowHome[]): string {
  const cols = ["zpid", "address", "zip", "lat", "lng", "price", "beds", "baths", "sqft",
    "lot_sqft", "property_type", "dom", "status", "url", "photo"];
  const cell = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = homes.map((h) => [
    h.zpid, h.address, h.zip, h.lat, h.lng, h.price, h.beds, h.baths, h.sqft, h.lotSqft,
    h.homeType ? TYPE[h.homeType] ?? h.homeType : null, h.dom, "active",
    // rebuilt from the id rather than trusting a pasted URL
    `https://www.zillow.com/homedetails/${h.zpid}_zpid/`,
    h.photo,
  ].map(cell).join(","));
  return [cols.join(","), ...rows].join("\n") + "\n";
}
