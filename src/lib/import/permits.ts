/**
 * Permit row normalization + duplicate detection (Phase 2).
 *
 * Pure: rows in, classified rows out. Geocoding and parcel matching happen
 * afterwards in the route handler, which owns the I/O.
 *
 * Row statuses mirror the match report in the spec:
 *   invalid    — no usable address; cannot proceed
 *   duplicate  — same license #, or same address+unit, as an earlier row
 *   ready      — normalized, awaiting geocode / parcel match
 */
import { composeAddress, parseAddress } from "../address";
import {
  type ColumnMapping, normalizeHeader, parseStrType, parsePermitStatus, parseDate, numOrNull,
} from "./columns";

export type NormalizedPermit = {
  rowNumber: number;
  externalId: string;
  permitNumber: string | null;
  occupationLicense: string | null;
  owner: string | null;
  addressRaw: string;
  addressNorm: string;
  unit: string | null;
  zip: string | null;
  strType: "hosted" | "unhosted" | null;
  permitStatus: "active" | "expired" | "pending" | "revoked" | "unknown";
  issueDate: string | null;
  expirationDate: string | null;
  lat: number | null;
  lng: number | null;
  notes: string | null;
  status: "ready" | "invalid" | "duplicate";
  duplicateOfRow: number | null;
  errors: string[];
  raw: Record<string, string>;
};

export type NormalizeResult = {
  rows: NormalizedPermit[];
  counts: { total: number; ready: number; invalid: number; duplicate: number; unclassified: number; withCoords: number };
};

const val = (row: Record<string, string>, mapping: ColumnMapping, field: keyof ColumnMapping): string => {
  const header = mapping[field];
  if (!header) return "";
  return String(row[normalizeHeader(header)] ?? "").trim();
};

/**
 * Stable external id so re-importing the same file updates rows instead of
 * duplicating them. Prefers the source's own id, then the license number, and
 * falls back to the canonical address key.
 */
export function permitExternalId(p: { externalId?: string; permitNumber: string | null; addressNorm: string; unit: string | null }): string {
  if (p.externalId) return p.externalId;
  if (p.permitNumber) return `lic:${p.permitNumber}`;
  return `addr:${p.addressNorm}${p.unit ? `#${p.unit}` : ""}`;
}

export function normalizePermitRows(rows: Record<string, string>[], mapping: ColumnMapping): NormalizeResult {
  const out: NormalizedPermit[] = [];
  const byLicense = new Map<string, number>();
  const byAddress = new Map<string, number>();

  rows.forEach((row, i) => {
    const rowNumber = i + 1;
    const errors: string[] = [];

    const full = val(row, mapping, "address_full");
    const composed = full || composeAddress({
      number: val(row, mapping, "address_number"),
      direction: val(row, mapping, "address_direction"),
      street: val(row, mapping, "address_street"),
      suffix: val(row, mapping, "address_suffix"),
      unit: val(row, mapping, "address_unit"),
      zip: val(row, mapping, "zip"),
    });
    const parsed = parseAddress(composed);
    // a mapped unit column wins over one embedded in a full-address string
    const mappedUnit = val(row, mapping, "address_unit").replace(/^#\s*/, "").trim();
    const unit = (mappedUnit && mappedUnit !== "0" ? mappedUnit : parsed.unit) || null;
    const zip = val(row, mapping, "zip").slice(0, 5) || parsed.zip;

    if (!parsed.normalized) errors.push("No usable address in the mapped columns.");
    else if (!parsed.number) errors.push(`No street number in "${composed}" — cannot be geocoded to a parcel.`);

    const permitNumber = val(row, mapping, "permit_number") || null;
    const strType = parseStrType(val(row, mapping, "str_type"));
    const lat = numOrNull(val(row, mapping, "lat"));
    const lng = numOrNull(val(row, mapping, "lng"));
    const coordsOk = lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
    if ((lat != null) !== (lng != null)) errors.push("Only one of latitude/longitude is present; both are required.");

    const rec: NormalizedPermit = {
      rowNumber,
      externalId: "",
      permitNumber,
      occupationLicense: val(row, mapping, "occupation_license") || null,
      owner: val(row, mapping, "owner") || null,
      addressRaw: composed,
      addressNorm: parsed.normalized,
      unit,
      zip: zip || null,
      strType,
      permitStatus: parsePermitStatus(val(row, mapping, "permit_status")),
      issueDate: parseDate(val(row, mapping, "issue_date")),
      expirationDate: parseDate(val(row, mapping, "expiration_date")),
      lat: coordsOk ? lat : null,
      lng: coordsOk ? lng : null,
      notes: val(row, mapping, "notes") || null,
      status: errors.length ? "invalid" : "ready",
      duplicateOfRow: null,
      errors,
      raw: row,
    };
    rec.externalId = permitExternalId({
      externalId: val(row, mapping, "external_id") || undefined,
      permitNumber, addressNorm: rec.addressNorm, unit: rec.unit,
    });

    if (rec.status === "ready") {
      const licKey = permitNumber ? permitNumber.toUpperCase() : null;
      const addrKey = `${rec.addressNorm}|${rec.unit ?? ""}`;
      const prior = (licKey && byLicense.get(licKey)) ?? byAddress.get(addrKey);
      if (prior) {
        rec.status = "duplicate";
        rec.duplicateOfRow = prior;
        rec.errors.push(licKey && byLicense.has(licKey)
          ? `Same STR license # as row ${prior}.`
          : `Same address and unit as row ${prior}.`);
      } else {
        if (licKey) byLicense.set(licKey, rowNumber);
        byAddress.set(addrKey, rowNumber);
      }
    }
    out.push(rec);
  });

  return {
    rows: out,
    counts: {
      total: out.length,
      ready: out.filter((r) => r.status === "ready").length,
      invalid: out.filter((r) => r.status === "invalid").length,
      duplicate: out.filter((r) => r.status === "duplicate").length,
      unclassified: out.filter((r) => r.status !== "invalid" && r.strType === null).length,
      withCoords: out.filter((r) => r.lat != null).length,
    },
  };
}

/**
 * Match status for a normalized row once geocoding has run.
 * Thresholds are deliberate: only an exact address-point hit is 'matched'.
 */
export function matchStatusFor(confidence: number | null, hasCoords: boolean): "matched" | "possible" | "unmatched" {
  if (!hasCoords) return "unmatched";
  if (confidence != null && confidence >= 0.9) return "matched";
  return "possible";
}
