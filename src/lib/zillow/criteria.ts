/**
 * The Zillow search the app pulls from: Lexington, KY, for sale, with a
 * minimum bed and bath count and an HOA ceiling.
 *
 * Stored in app_settings under ZILLOW_SETTINGS_KEY so the on-demand pull on
 * /zillow and the weekly scheduled pull read the same numbers. Changing them
 * in the app changes next Monday's pull too.
 */
export type ZillowCriteria = { bedsMin: number; bathsMin: number; hoaMax: number };

export const ZILLOW_SETTINGS_KEY = "zillow_search";
export const DEFAULT_CRITERIA: ZillowCriteria = { bedsMin: 4, bathsMin: 3, hoaMax: 0 };

/** Lexington, KY as Zillow knows it. */
const REGION = { regionId: 25574, regionType: 6 };
const BOUNDS = {
  west: -84.6964414038086, east: -84.32496618408204,
  south: 37.916986811795695, north: 38.156566399445715,
};

/**
 * Coerce anything (a form, a stored row, a query string) into valid criteria,
 * or report why it cannot be. Beds and baths are whole numbers from 1 to 10;
 * the HOA ceiling is whole dollars a month, 0 meaning "no HOA".
 */
export function parseCriteria(raw: unknown): { ok: true; value: ZillowCriteria } | { ok: false; error: string } {
  const o = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown, fallback: number) => (v === undefined || v === null || v === "" ? fallback : Number(v));
  const bedsMin = num(o.bedsMin, DEFAULT_CRITERIA.bedsMin);
  const bathsMin = num(o.bathsMin, DEFAULT_CRITERIA.bathsMin);
  const hoaMax = num(o.hoaMax, DEFAULT_CRITERIA.hoaMax);
  for (const [name, v, lo, hi] of [["Bedrooms", bedsMin, 1, 10], ["Bathrooms", bathsMin, 1, 10], ["HOA ceiling", hoaMax, 0, 5000]] as const) {
    if (!Number.isInteger(v) || v < lo || v > hi) return { ok: false, error: `${name} must be a whole number from ${lo} to ${hi}.` };
  }
  return { ok: true, value: { bedsMin, bathsMin, hoaMax } };
}

/** The filterState Zillow echoes back, reduced to what we set, for comparison. */
export function filterSignature(c: ZillowCriteria): string {
  return `beds>=${c.bedsMin}|baths>=${c.bathsMin}|hoa<=${c.hoaMax}`;
}

/** Read the same signature out of the filterState a Zillow page reports. */
export function signatureFromZillowFilters(f: any): string | null {
  const beds = f?.beds?.min, baths = f?.baths?.min, hoa = f?.hoa?.max;
  if (beds == null || baths == null || hoa == null) return null;
  return `beds>=${beds}|baths>=${baths}|hoa<=${hoa}`;
}

export function zillowSearchUrl(c: ZillowCriteria): string {
  const state = {
    pagination: {},
    isMapVisible: true,
    mapBounds: BOUNDS,
    regionSelection: [REGION],
    filterState: {
      sort: { value: "globalrelevanceex" },
      beds: { min: c.bedsMin },
      baths: { min: c.bathsMin },
      hoa: { max: c.hoaMax },
    },
    isListVisible: true,
    mapZoom: 12,
    usersSearchTerm: "Lexington KY",
  };
  return "https://www.zillow.com/lexington-ky/?searchQueryState=" + encodeURIComponent(JSON.stringify(state));
}
