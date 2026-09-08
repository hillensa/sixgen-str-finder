/**
 * Column mapping for the STR permit import wizard (Phase 2).
 *
 * The spec's requirement is "don't assume columns": the ORR-2026-1259 file uses
 * five separate address columns on the 2026 tab and a single "Property Address"
 * column on the 2024 tab. So the wizard *suggests* a mapping and the operator
 * confirms it; nothing here is applied without an explicit commit.
 *
 * Pure functions — unit-tested in tests/columns.test.ts.
 */

export type PermitField =
  | "external_id" | "permit_number" | "occupation_license" | "owner"
  | "address_full" | "address_number" | "address_unit" | "address_direction"
  | "address_street" | "address_suffix" | "zip"
  | "str_type" | "permit_status" | "issue_date" | "expiration_date"
  | "lat" | "lng" | "notes";

export type ColumnMapping = Partial<Record<PermitField, string>>;

export type FieldSpec = {
  key: PermitField;
  label: string;
  group: "identity" | "address" | "classification" | "dates" | "geometry" | "other";
  hint?: string;
  aliases: RegExp[];
};

/** Header keys are normalized the same way parseCsv normalizes them: lower_snake. */
export const normalizeHeader = (h: string) =>
  String(h ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

export const FIELD_SPECS: FieldSpec[] = [
  { key: "permit_number", label: "STR license #", group: "identity", aliases: [/^str_?licen[sc]e/, /^licen[sc]e_?(number|no|num|#)?$/, /^str_?permit/, /^permit_?(number|no|num)?$/] },
  { key: "occupation_license", label: "Occupation license #", group: "identity", aliases: [/occupation/] },
  { key: "external_id", label: "Source row id", group: "identity", hint: "Optional. Omitted → derived from license # + address, so re-imports update instead of duplicating.", aliases: [/^objectid$/, /^oid$/, /^row_?id$/, /^id$/] },
  { key: "owner", label: "Owner name", group: "identity", aliases: [/^owner/, /^owners?$/, /applicant/] },

  { key: "address_full", label: "Full address (single column)", group: "address", hint: "Use this OR the split columns below, not both.", aliases: [/^property_?address$/, /^full_?address$/, /^site_?address$/, /^address$/, /^street_?address$/, /^location$/] },
  { key: "address_number", label: "Street number", group: "address", aliases: [/^street_?number$/, /^house_?number$/, /^st_?num/, /^number$/, /^addr_?num/] },
  { key: "address_direction", label: "Direction", group: "address", aliases: [/^direction$/, /^dir$/, /^pre_?dir/] },
  { key: "address_street", label: "Street name", group: "address", aliases: [/^street_?name$/, /^st_?name$/, /^street$/] },
  { key: "address_suffix", label: "Suffix", group: "address", aliases: [/^suffix$/, /^st_?type$/, /^street_?type$/, /^post_?type$/] },
  { key: "address_unit", label: "Unit", group: "address", aliases: [/^unit$/, /^apt/, /^suite$/, /^ste$/, /^unit_?(number|no)$/] },
  { key: "zip", label: "ZIP", group: "address", aliases: [/^zip/, /^postal/] },

  { key: "str_type", label: "Hosted / un-hosted", group: "classification", hint: "Drives the blocking flag. Rows this cannot classify are treated as blocking.", aliases: [/hosted/, /^str_?type$/, /^rental_?type$/, /^type$/] },
  { key: "permit_status", label: "Permit status", group: "classification", aliases: [/^status$/, /^permit_?status$/, /^licen[sc]e_?status$/, /^active$/] },

  { key: "issue_date", label: "Issue date", group: "dates", aliases: [/^issue/, /^issued/, /^start_?date$/, /^effective/] },
  // deliberately not a bare /expir/: the ORR file's "Insurance Expiration" is a
  // different date, and auto-mapping it as the permit expiry would be a lie
  { key: "expiration_date", label: "Expiration date", group: "dates", aliases: [/^expir/, /^(permit|licen[sc]e|str)_?expir/, /^end_?date$/, /^renewal/] },

  { key: "lat", label: "Latitude", group: "geometry", hint: "Optional. Present → geocoding is skipped for that row.", aliases: [/^lat/, /^y$/] },
  { key: "lng", label: "Longitude", group: "geometry", aliases: [/^lon/, /^lng$/, /^long$/, /^x$/] },

  { key: "notes", label: "Notes", group: "other", aliases: [/^notes?$/, /^comment/, /^remark/] },
];

const SPEC_BY_KEY = new Map(FIELD_SPECS.map((f) => [f.key, f]));

/**
 * Best-effort mapping from a file's headers. Each header is claimed by at most
 * one field, and each field by at most one header (first match wins, in
 * FIELD_SPECS order, so the specific patterns beat the generic ones).
 */
export function suggestMapping(headers: string[]): { mapping: ColumnMapping; unmapped: string[] } {
  const keys = headers.map(normalizeHeader).filter(Boolean);
  const mapping: ColumnMapping = {};
  const claimed = new Set<string>();

  for (const spec of FIELD_SPECS) {
    for (const rx of spec.aliases) {
      const hit = keys.find((k) => !claimed.has(k) && rx.test(k));
      if (hit) { mapping[spec.key] = hit; claimed.add(hit); break; }
    }
  }
  // A file with split address columns should not also claim a generic "address".
  if (mapping.address_number && mapping.address_street && mapping.address_full) delete mapping.address_full;
  return { mapping, unmapped: keys.filter((k) => !claimed.has(k)) };
}

/** Blocking problems with a proposed mapping. Empty array = safe to commit. */
export function validateMapping(mapping: ColumnMapping, headers: string[]): string[] {
  const keys = new Set(headers.map(normalizeHeader));
  const errors: string[] = [];

  for (const [field, header] of Object.entries(mapping) as [PermitField, string][]) {
    if (header && !keys.has(header)) errors.push(`${SPEC_BY_KEY.get(field)?.label ?? field} is mapped to "${header}", which is not a column in this file.`);
  }
  const hasFull = !!mapping.address_full;
  const hasSplit = !!(mapping.address_number && mapping.address_street);
  if (!hasFull && !hasSplit)
    errors.push("Map either a full address column, or both Street number and Street name.");
  if (!mapping.str_type)
    errors.push("Map the hosted / un-hosted column. Without it every row is classified as blocking, which is safe but useless.");

  const dupes = new Map<string, PermitField[]>();
  for (const [field, header] of Object.entries(mapping) as [PermitField, string][]) {
    if (!header) continue;
    dupes.set(header, [...(dupes.get(header) ?? []), field]);
  }
  for (const [header, fields] of dupes) if (fields.length > 1)
    errors.push(`Column "${header}" is mapped to ${fields.length} fields (${fields.join(", ")}). Each column maps to one field.`);

  return errors;
}

/** Non-blocking things the operator should see before committing. */
export function mappingWarnings(mapping: ColumnMapping, unmapped: string[]): string[] {
  const w: string[] = [];
  if (!mapping.permit_status) w.push("No permit-status column — every row will be stored as status “unknown”, which counts as blocking under the current rules.");
  if (!mapping.permit_number) w.push("No STR license # — rows will be keyed on address alone, so a second permit at the same address looks like a duplicate.");
  if (!mapping.zip && !mapping.address_full) w.push("No ZIP column — geocoding falls back to city-wide address search, which is less precise.");
  if (mapping.lat && !mapping.lng) w.push("Latitude is mapped but longitude is not; both are needed to skip geocoding.");
  if (unmapped.length) w.push(`${unmapped.length} column${unmapped.length === 1 ? "" : "s"} left unmapped and stored in the raw row: ${unmapped.slice(0, 8).join(", ")}${unmapped.length > 8 ? "…" : ""}`);
  return w;
}

// ─────────────────────────── value normalization ───────────────────────────

/**
 * Hosted / un-hosted. Accepts "U", "UN", "UNHOSTED", "UN-HOSTED", "NOT HOSTED",
 * "N" and the hosted equivalents. Returns null when it genuinely cannot tell —
 * the caller must then treat the permit as blocking, not as clear.
 */
export function parseStrType(v: unknown): "hosted" | "unhosted" | null {
  const s = String(v ?? "").toUpperCase().replace(/[^A-Z]/g, "");
  if (!s) return null;
  // "UNKNOWN" also starts with UN — it must stay null, not become "unhosted"
  if (/^(UNKNOWN|UNK|NA|NONE|TBD|PENDING|BLANK)$/.test(s)) return null;
  if (s.startsWith("UN") || s.startsWith("NOT") || s === "U" || s === "N") return "unhosted";
  if (s.startsWith("HOST") || s === "H" || s === "Y") return "hosted";
  return null;
}

/** Permit status. Anything unrecognized becomes "unknown" — never "active". */
export function parsePermitStatus(v: unknown): "active" | "expired" | "pending" | "revoked" | "unknown" {
  const s = String(v ?? "").toUpperCase().trim();
  if (!s) return "unknown";
  if (/^(A|ACTIVE|CURRENT|ISSUED|VALID|APPROVED|Y|YES|TRUE|1)$/.test(s)) return "active";
  if (/EXPIR|LAPSED|CLOSED|INACTIVE/.test(s)) return "expired";
  if (/PEND|REVIEW|APPLIED|SUBMITTED/.test(s)) return "pending";
  if (/REVOK|DENIED|SUSPEND|CANCEL/.test(s)) return "revoked";
  return "unknown";
}

/** Loose date → ISO yyyy-mm-dd, or null. Accepts m/d/yyyy, yyyy-mm-dd, and Excel serials. */
export function parseDate(v: unknown): string | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const us = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (us) {
    const yr = us[3].length === 2 ? Number(us[3]) + 2000 : Number(us[3]);
    const d = new Date(Date.UTC(yr, Number(us[1]) - 1, Number(us[2])));
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  if (/^\d{5}(\.\d+)?$/.test(s)) {                       // Excel 1900 serial
    const d = new Date(Date.UTC(1899, 11, 30) + Number(s) * 86400000);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export const numOrNull = (v: unknown): number | null => {
  const s = String(v ?? "").replace(/[^0-9.\-]/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
