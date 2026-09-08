/**
 * Address normalization for the permit import pipeline (spec §12, Phase 2).
 *
 * Pure functions — no I/O — so the whole normalize → dedupe → match path is
 * unit-tested. The ORR-2026-1259 file splits an address across five columns
 * (Street Number · Unit · Direction · Street Name · Suffix) while the 2024 tab
 * uses a single "Property Address" column, so both shapes must produce the same
 * canonical string.
 */

/** USPS C1 suffix abbreviations (the ones that actually occur in Fayette County data). */
const SUFFIX: Record<string, string> = {
  ALLEY: "ALY", ALY: "ALY", AVENUE: "AVE", AVE: "AVE", AV: "AVE",
  BOULEVARD: "BLVD", BLVD: "BLVD", BLV: "BLVD",
  CIRCLE: "CIR", CIR: "CIR", CIRC: "CIR",
  COURT: "CT", CT: "CT", COVE: "CV", CV: "CV",
  CRESCENT: "CRES", CRES: "CRES", CROSSING: "XING", XING: "XING",
  DRIVE: "DR", DR: "DR", DRV: "DR",
  EXPRESSWAY: "EXPY", EXPY: "EXPY",
  GARDEN: "GDN", GARDENS: "GDNS", GLEN: "GLN", GLN: "GLN", GREEN: "GRN",
  HEIGHTS: "HTS", HTS: "HTS", HIGHWAY: "HWY", HWY: "HWY", HILL: "HL", HILLS: "HLS", HOLLOW: "HOLW",
  JUNCTION: "JCT",
  LANE: "LN", LN: "LN", LOOP: "LOOP",
  MANOR: "MNR", MNR: "MNR", MEADOW: "MDW", MEADOWS: "MDWS", MILL: "ML",
  PARK: "PARK", PARKWAY: "PKWY", PKWY: "PKWY", PKY: "PKWY",
  PASS: "PASS", PATH: "PATH", PIKE: "PIKE", PLACE: "PL", PL: "PL",
  PLAZA: "PLZ", PLZ: "PLZ", POINT: "PT", PT: "PT",
  RIDGE: "RDG", RDG: "RDG", ROAD: "RD", RD: "RD", RUN: "RUN",
  SQUARE: "SQ", SQ: "SQ", STREET: "ST", ST: "ST", STR: "ST",
  TERRACE: "TER", TER: "TER", TRACE: "TRCE", TRAIL: "TRL", TRL: "TRL", TURNPIKE: "TPKE",
  VALLEY: "VLY", VIEW: "VW", VILLAGE: "VLG",
  WALK: "WALK", WAY: "WAY", WY: "WAY",
};

const DIRECTION: Record<string, string> = {
  NORTH: "N", N: "N", SOUTH: "S", S: "S", EAST: "E", E: "E", WEST: "W", W: "W",
  NORTHEAST: "NE", NE: "NE", NORTHWEST: "NW", NW: "NW",
  SOUTHEAST: "SE", SE: "SE", SOUTHWEST: "SW", SW: "SW",
};

/** Secondary-unit designators. Kept out of the street key so 12 A and 12 B match the same parcel. */
const UNIT_WORDS = new Set(["APT", "APARTMENT", "UNIT", "STE", "SUITE", "BLDG", "BUILDING", "#", "NO", "LOT", "TRLR", "RM", "ROOM", "FL", "FLOOR"]);

export type AddressParts = {
  number?: string | null;
  direction?: string | null;
  street?: string | null;
  suffix?: string | null;
  postDirection?: string | null;
  unit?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
};

export type ParsedAddress = {
  /** Canonical single-line form, e.g. "697 CINDY BLAIR WAY". Never includes the unit. */
  normalized: string;
  /** Dedupe key: normalized street address + unit, e.g. "697 CINDY BLAIR WAY|2B". */
  key: string;
  number: string | null;
  direction: string | null;
  street: string | null;
  suffix: string | null;
  unit: string | null;
  zip: string | null;
  /** Full display form including unit and zip when present. */
  display: string;
};

const clean = (v: unknown): string =>
  String(v ?? "").toUpperCase().replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();

/** Assemble a single address string from separate columns (the ORR 2026 tab shape). */
export function composeAddress(parts: AddressParts): string {
  const bits = [
    clean(parts.number),
    DIRECTION[clean(parts.direction)] ?? clean(parts.direction),
    clean(parts.street),
    SUFFIX[clean(parts.suffix)] ?? clean(parts.suffix),
    DIRECTION[clean(parts.postDirection)] ?? clean(parts.postDirection),
  ].filter(Boolean);
  let s = bits.join(" ");
  const unit = clean(parts.unit);
  if (unit && unit !== "0") s += ` # ${unit.replace(/^#\s*/, "")}`;
  const city = clean(parts.city), st = clean(parts.state), zip = clean(parts.zip);
  if (city) s += `, ${city}`;
  if (st) s += ` ${st}`;
  if (zip) s += ` ${zip.slice(0, 5)}`;
  return s.trim();
}

/**
 * Parse and canonicalize a one-line address. Tolerant of the shapes that occur
 * in city files: trailing city/state/zip, "APT 3", "#3", "STE B", "3865-B".
 */
export function parseAddress(raw: string): ParsedAddress {
  let s = clean(raw);

  // trailing ZIP (5 or ZIP+4) — captured, then removed from the street portion
  let zip: string | null = null;
  const zm = s.match(/\b(\d{5})(?:-\d{4})?\s*$/);
  if (zm) { zip = zm[1]; s = s.slice(0, zm.index).trim(); }

  // drop a trailing ", LEXINGTON KY" / "LEXINGTON KY" tail
  s = s.replace(/[, ]+(LEXINGTON|FAYETTE)\s*(KY|KENTUCKY)?\s*$/i, "").trim();
  s = s.replace(/[, ]+(KY|KENTUCKY)\s*$/i, "").trim();
  s = s.replace(/,/g, " ").replace(/\s+/g, " ").trim();

  // secondary unit: "# 3", "APT 3", "UNIT B", or a hyphenated house number "3865-B"
  let unit: string | null = null;
  const hashed = s.match(/\s#\s*([A-Z0-9-]+)\s*$/);
  if (hashed) { unit = hashed[1]; s = s.slice(0, hashed.index).trim(); }
  if (!unit) {
    const words = s.split(" ");
    for (let i = words.length - 2; i >= 1; i--) {
      if (UNIT_WORDS.has(words[i])) { unit = words.slice(i + 1).join(" "); s = words.slice(0, i).join(" "); break; }
    }
  }

  const words = s.split(" ").filter(Boolean);
  let number: string | null = null;
  if (words.length && /^\d/.test(words[0])) {
    const first = words.shift()!;
    const hy = first.match(/^(\d+)-([A-Z0-9]+)$/);
    if (hy) { number = hy[1]; unit = unit ?? hy[2]; } else number = first;
  }

  let direction: string | null = null;
  if (words.length > 1 && DIRECTION[words[0]]) direction = DIRECTION[words.shift()!];

  let suffix: string | null = null;
  if (words.length > 1) {
    const last = words[words.length - 1];
    if (SUFFIX[last]) { suffix = SUFFIX[last]; words.pop(); }
  }

  // post-directional ("MAIN ST W") — fold back into the street name position
  let post: string | null = null;
  if (words.length > 1 && DIRECTION[words[words.length - 1]]) post = DIRECTION[words.pop()!];

  const street = words.join(" ") || null;
  const normalized = [number, direction, street, suffix, post].filter(Boolean).join(" ");
  const display = [normalized, unit ? `# ${unit}` : "", zip ? `Lexington, KY ${zip}` : ""].filter(Boolean).join(", ");

  return {
    normalized,
    key: `${normalized}|${unit ?? ""}`,
    number, direction, street, suffix,
    unit: unit ?? null,
    zip,
    display: display || normalized,
  };
}

/** Convenience: the canonical street address only, matching str_permits.address_norm. */
export function normalizeAddress(raw: string): string {
  return parseAddress(raw).normalized;
}

/**
 * 0..1 similarity between two addresses, tuned for geocoder candidate ranking.
 * The house number is a hard gate — 697 Cindy Blair and 679 Cindy Blair are not
 * "97% the same address", they are different houses.
 */
export function addressSimilarity(a: string, b: string): number {
  const pa = parseAddress(a), pb = parseAddress(b);
  if (!pa.normalized || !pb.normalized) return 0;
  if (pa.number && pb.number && pa.number !== pb.number) return 0;
  if (!!pa.number !== !!pb.number) return 0;

  let score = pa.number ? 0.4 : 0.2;
  const sa = (pa.street ?? "").split(" ").filter(Boolean);
  const sb = (pb.street ?? "").split(" ").filter(Boolean);
  if (sa.length && sb.length) {
    const setB = new Set(sb);
    const hit = sa.filter((t) => setB.has(t)).length;
    score += 0.45 * (hit / Math.max(sa.length, sb.length));
  }
  if (pa.suffix && pb.suffix) score += pa.suffix === pb.suffix ? 0.1 : 0;
  else if (!pa.suffix && !pb.suffix) score += 0.05;
  if (pa.direction === pb.direction) score += 0.05;
  return Math.min(1, +score.toFixed(3));
}
