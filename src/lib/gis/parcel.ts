import { fetchParcelAtPoint, fetchZoningAtPoint } from "../arcgis";
import { upsertZoningDistricts } from "./zoning";
import type { Jurisdiction, ParcelLookup } from "../types";

/** Signed area (shoelace). Negative = clockwise, which is ArcGIS's exterior winding. */
function signedArea(ring: number[][]): number {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

/**
 * ArcGIS `rings` (4326) → GeoJSON MultiPolygon.
 *
 * ArcGIS flattens exterior rings AND holes into one flat `rings` array and
 * distinguishes them only by winding: exterior is clockwise, holes are
 * counter-clockwise. Wrapping the whole array as `[rings]` — one polygon whose
 * every ring after the first is a hole — silently turns a two-part parcel into
 * one part with a hole punched through it, which then produces the wrong 600-ft
 * buffer. So split on winding, and emit RFC 7946 orientation (exterior CCW,
 * holes CW) by reversing each ring.
 */
export function ringsToMultiPolygon(rings: number[][][]) {
  const polys: number[][][][] = [];
  for (const ring of rings ?? []) {
    if (!ring || ring.length < 4) continue;
    const exterior = signedArea(ring) < 0;              // ArcGIS clockwise
    const oriented = [...ring].reverse();               // → GeoJSON winding
    if (exterior || polys.length === 0) polys.push([oriented]);
    else polys[polys.length - 1].push(oriented);
  }
  return { type: "MultiPolygon", coordinates: polys };
}

/**
 * Pull the parcel identifier and acreage out of a jurisdiction's attributes.
 *
 * LFUCG names these `PVANUM` and `PVA_ACRE`. Earlier code guessed at `PVA_NUM`,
 * `PARCEL_ID`, `PIN`, `ACREAGE` and `Acres` — none of which exist on that layer,
 * so every cached parcel stored null for both. The same mapping was copied into
 * three call sites, which is how it went unnoticed; it lives here now.
 *
 * The aliases are kept because the app is multi-market by design and the next
 * county will name them differently. `Shape__Area` is a last resort: it is the
 * geometry's own area in the layer's projected units (square US survey feet for
 * SRID 2246), so it converts, but the assessor's own figure is preferred.
 */
export function parcelAttrs(attrs: Record<string, any> | null | undefined): { pvaId: string | null; acreage: number | null } {
  const a = attrs ?? {};
  const pick = (...keys: string[]) => {
    for (const k of keys) if (a[k] != null && a[k] !== "") return a[k];
    return null;
  };

  const rawAcres = pick("PVA_ACRE", "PVA_ACRES", "ACREAGE", "ACRES", "Acres", "acreage");
  let acreage = rawAcres == null ? null : Number(rawAcres);
  if ((acreage == null || !Number.isFinite(acreage) || acreage <= 0) && Number(a.Shape__Area) > 0) {
    acreage = +(Number(a.Shape__Area) / 43560).toFixed(4);   // sq ft -> acres
  }

  const rawId = pick("PVANUM", "PVA_NUM", "PARCEL_ID", "PARCELID", "PIN", "TAXID");
  return {
    pvaId: rawId == null ? null : String(rawId),
    acreage: acreage != null && Number.isFinite(acreage) && acreage > 0 ? acreage : null,
  };
}

/**
 * Resolve a WGS84 point to its parcel and zoning. Reads the DB cache first;
 * on miss, queries LFUCG and caches the parcel + zoning rows so subsequent
 * lookups (and PostGIS functions) have local geometry to work with.
 */
export async function resolveParcel(db: any, j: Jurisdiction, lng: number, lat: number): Promise<ParcelLookup> {
  const now = new Date().toISOString();

  // cache hit?
  const { data: cached } = await db.rpc("fn_parcel_at", { p_jurisdiction: j.id, p_lng: lng, p_lat: lat });
  let parcelRow = cached?.[0] ?? null;
  let parcelGeom: any = null;

  if (!parcelRow && j.gis_parcel_url) {
    const p = await fetchParcelAtPoint(j.gis_parcel_url, lng, lat);
    if (p) {
      parcelGeom = ringsToMultiPolygon(p.rings);
      const { pvaId, acreage } = parcelAttrs(p.attrs);
      const { data: ins } = await db.from("parcels").upsert({
        jurisdiction_id: j.id, source_object_id: p.objectId, pva_id: pvaId,
        address: p.attrs?.ADDRESS ?? null, acreage,
        centroid_lng: lng, centroid_lat: lat, geom: parcelGeom, attrs: p.attrs, fetched_at: now,
      }, { onConflict: "jurisdiction_id,source_object_id" }).select("id,address,zone_code,acreage,pva_id").single();
      parcelRow = ins ? { parcel_id: ins.id, address: ins.address, zone_code: ins.zone_code, acreage: ins.acreage, pva_id: ins.pva_id, source_object_id: p.objectId } : null;
    }
  }

  // zoning (cache → live)
  const { data: zc } = await db.rpc("fn_zoning_at", { p_jurisdiction: j.id, p_lng: lng, p_lat: lat });
  let zone = zc?.[0] ?? null;
  if (!zone && j.gis_zoning_url) {
    const z = await fetchZoningAtPoint(j.gis_zoning_url, lng, lat);
    if (z) {
      // Lookup-then-write, not upsert: zoning_districts_uniq is a PARTIAL index,
      // which Postgres will not use to arbitrate ON CONFLICT. The upsert that
      // used to be here failed every time, and its result was never checked — so
      // the zoning cache stayed empty and every eligibility screen that reads it
      // reported ZONING_UNKNOWN. This screen looked fine only because it uses the
      // live answer it just fetched.
      const { error } = await upsertZoningDistricts(db, [{
        jurisdiction_id: j.id, zone_code: z.zone, ordinance_url: z.link, source_object_id: z.objectId,
        geom: ringsToMultiPolygon(z.rings), fetched_at: now,
      }]);
      if (error) {
        await db.from("data_errors").insert({
          category: "gis", entity: "zoning_districts", entity_id: String(z.objectId),
          message: `Caching zoning failed: ${error}`,
        }).then(() => {}, () => {});
      }
      zone = { zone_code: z.zone, zone_name: null, ordinance_url: z.link };
    }
  }
  if (parcelRow?.parcel_id && zone?.zone_code && !parcelRow.zone_code) {
    await db.from("parcels").update({ zone_code: zone.zone_code }).eq("id", parcelRow.parcel_id);
  }

  if (!parcelRow) return { found: false, source: "LFUCG GIS", fetched_at: now, zoning: zone ? { zone_code: zone.zone_code, ordinance_url: zone.ordinance_url, treatment: null } : undefined };

  if (!parcelGeom && parcelRow.parcel_id) {
    const { data: g } = await db.from("parcels").select("geom").eq("id", parcelRow.parcel_id).single();
    parcelGeom = g?.geom ?? null;
  }
  return {
    found: true,
    parcel: { id: parcelRow.parcel_id ?? null, source_object_id: parcelRow.source_object_id ?? 0, address: parcelRow.address, acreage: parcelRow.acreage, geometry: parcelGeom },
    zoning: zone ? { zone_code: zone.zone_code, ordinance_url: zone.ordinance_url, treatment: null } : undefined,
    source: "LFUCG GIS", fetched_at: now,
  };
}
