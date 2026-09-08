/** Thin client for public ArcGIS FeatureServer layers. POST so geometry never hits URL limits. */
import { parseStrType } from "./import/columns";
type Json = Record<string, any>;

export async function arcQuery(layerUrl: string, params: Record<string, string>, revalidate = 300): Promise<Json> {
  const body = new URLSearchParams({ f: "json", ...params });
  const res = await fetch(`${layerUrl}/query`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body,
    next: { revalidate },
  } as any);
  if (!res.ok) throw new Error(`ArcGIS HTTP ${res.status}`);
  const json = (await res.json()) as Json;
  if (json.error) throw new Error(`ArcGIS: ${json.error.message ?? JSON.stringify(json.error)}`);
  return json;
}

export type ArcPermit = {
  externalId: string; address: string;
  /** Raw value of the layer's hosted/un-hosted field, kept verbatim for provenance. */
  hostedRaw: string;
  /** Classified type, or null when the raw value is not recognizable. */
  strType: "hosted" | "unhosted" | null;
  license: string;
  /** null when the layer published the record without geometry — the row is still imported. */
  x: number | null; y: number | null;
};

/**
 * Every STR record in the city layer.
 *
 * Two deliberate choices:
 *  · `outSR` is pinned to the market's projected SRID so the caller's proj4
 *    conversion can never silently disagree with the layer's native SR.
 *  · records without geometry are returned with null coordinates rather than
 *    dropped — the map shows them as "unlocated" (see lib/permits.ts).
 */
export async function fetchStrPermits(layerUrl: string, outSR: number): Promise<ArcPermit[]> {
  const out: ArcPermit[] = []; let offset = 0;
  for (let i = 0; i < 40; i++) {
    const j = await arcQuery(layerUrl, {
      where: "1=1", outFields: "objectid,address,hosted__unhosted,license_number",
      returnGeometry: "true", outSR: String(outSR),
      resultOffset: String(offset), resultRecordCount: "1000",
    });
    const feats: Json[] = j.features ?? [];
    for (const f of feats) {
      const hostedRaw = String(f.attributes?.hosted__unhosted ?? "").trim();
      out.push({
        externalId: String(f.attributes?.objectid ?? ""),
        address: String(f.attributes?.address ?? "").trim(),
        hostedRaw,
        strType: parseStrType(hostedRaw),
        license: String(f.attributes?.license_number ?? "").trim(),
        x: typeof f.geometry?.x === "number" ? f.geometry.x : null,
        y: typeof f.geometry?.y === "number" ? f.geometry.y : null,
      });
    }
    if (!j.exceededTransferLimit || feats.length === 0) break;
    offset += feats.length;
  }
  return out;
}

/** Parcel polygon(s) intersecting a WGS84 point, returned as GeoJSON in 4326. */
export async function fetchParcelAtPoint(layerUrl: string, lng: number, lat: number) {
  const j = await arcQuery(layerUrl, {
    geometry: JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } }),
    geometryType: "esriGeometryPoint", inSR: "4326", outSR: "4326",
    spatialRel: "esriSpatialRelIntersects", outFields: "*", geometryPrecision: "7",
  }, 60);
  const f = (j.features ?? [])[0];
  if (!f) return null;
  return { objectId: Number(f.attributes?.OBJECTID), attrs: f.attributes as Json, rings: f.geometry?.rings as number[][][] };
}

export async function fetchZoningAtPoint(layerUrl: string, lng: number, lat: number) {
  const j = await arcQuery(layerUrl, {
    geometry: JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } }),
    geometryType: "esriGeometryPoint", inSR: "4326", outSR: "4326",
    spatialRel: "esriSpatialRelIntersects", outFields: "OBJECTID,ZONING,LINK", geometryPrecision: "6",
  }, 600);
  const f = (j.features ?? [])[0];
  if (!f) return null;
  return { objectId: Number(f.attributes?.OBJECTID), zone: String(f.attributes?.ZONING ?? ""), link: (f.attributes?.LINK as string) || null, rings: f.geometry?.rings as number[][][] };
}

/** Parcels intersecting a multipoint batch (projected SRID). */
export async function fetchParcelsForPoints(layerUrl: string, pts: { x: number; y: number }[], srid: number, batch = 80) {
  const byId = new Map<number, { objectId: number; address: string; rings: number[][][]; attrs: Json }>();
  for (let i = 0; i < pts.length; i += batch) {
    const chunk = pts.slice(i, i + batch).map((p) => [p.x, p.y]);
    const j = await arcQuery(layerUrl, {
      geometry: JSON.stringify({ points: chunk }), geometryType: "esriGeometryMultipoint",
      inSR: String(srid), outSR: "4326", spatialRel: "esriSpatialRelIntersects", outFields: "*", geometryPrecision: "7",
    });
    for (const f of (j.features ?? []) as Json[]) {
      const oid = Number(f.attributes?.OBJECTID);
      if (Number.isFinite(oid) && !byId.has(oid) && f.geometry?.rings)
        byId.set(oid, { objectId: oid, address: String(f.attributes?.ADDRESS ?? ""), rings: f.geometry.rings, attrs: f.attributes });
    }
  }
  return [...byId.values()];
}

/**
 * Zoning districts intersecting a multipoint batch (projected SRID).
 *
 * The point-at-a-time version is fine for one address on the Test Address
 * screen; an import of several hundred listings needs one request per 80 points
 * rather than one per listing. A district is returned once no matter how many
 * of the points fall inside it, which is the common case in a subdivision.
 */
export async function fetchZoningForPoints(layerUrl: string, pts: { x: number; y: number }[], srid: number, batch = 80) {
  const byId = new Map<number, { objectId: number; zone: string; link: string | null; rings: number[][][] }>();
  for (let i = 0; i < pts.length; i += batch) {
    const chunk = pts.slice(i, i + batch).map((p) => [p.x, p.y]);
    const j = await arcQuery(layerUrl, {
      geometry: JSON.stringify({ points: chunk }), geometryType: "esriGeometryMultipoint",
      inSR: String(srid), outSR: "4326", spatialRel: "esriSpatialRelIntersects",
      outFields: "OBJECTID,ZONING,LINK", geometryPrecision: "6",
    });
    for (const f of (j.features ?? []) as Json[]) {
      const oid = Number(f.attributes?.OBJECTID);
      if (Number.isFinite(oid) && !byId.has(oid) && f.geometry?.rings)
        byId.set(oid, {
          objectId: oid, zone: String(f.attributes?.ZONING ?? ""),
          link: (f.attributes?.LINK as string) || null, rings: f.geometry.rings,
        });
    }
  }
  return [...byId.values()];
}

/** Escape a value for an ArcGIS SQL-92 `where` clause. */
export const sqlLiteral = (v: string) => `'${String(v).replace(/'/g, "''")}'`;
/** Escape a LIKE pattern: quotes plus the SQL wildcards themselves. */
export const likeLiteral = (v: string) => `'${String(v).replace(/'/g, "''").replace(/([%_])/g, "[$1]")}%'`;

export type AddressPoint = { address: string; type: string | null; lat: number; lng: number };

/** Address points matching an arbitrary where clause (WGS84 out). */
export async function queryAddressPoints(layerUrl: string, where: string, max = 12, revalidate = 300): Promise<AddressPoint[]> {
  const j = await arcQuery(layerUrl, {
    where, outFields: "ADDRESS,TYPE", returnGeometry: "true", outSR: "4326", resultRecordCount: String(max),
  }, revalidate);
  return ((j.features ?? []) as Json[])
    .filter((f) => typeof f.geometry?.x === "number" && typeof f.geometry?.y === "number")
    .map((f) => ({
      address: String(f.attributes?.ADDRESS ?? ""),
      type: (f.attributes?.TYPE as string) ?? null,
      lat: f.geometry.y as number, lng: f.geometry.x as number,
    }));
}

export async function searchAddresses(layerUrl: string, term: string) {
  return queryAddressPoints(layerUrl, `ADDRESS LIKE ${likeLiteral(term.toUpperCase())}`, 8, 60);
}
