/**
 * Populate the parcel and zoning caches for a set of property coordinates.
 *
 * `fn_link_properties_to_parcels` matches properties against parcels already in
 * the table, and `fn_eligibility_facts` resolves zoning from cached
 * `zoning_districts` polygons. Nothing in the listings path ever put rows there:
 * the parcel cache was filled only by the STR permit sync, which fetches
 * parcels around *permits*. So an imported listing more than a parcel away from
 * a permit had nothing to match, and came back PARCEL_NOT_MATCHED with
 * ZONING_UNKNOWN — distances measured from a point rather than a property line,
 * and every such property held for review regardless of merit.
 *
 * The Test Address screen never had this problem, because `resolveParcel`
 * fetches on a cache miss. This is the same idea for a batch: one multipoint
 * request per 80 properties instead of one request per property.
 *
 * A GIS failure here must not fail the import. The listings are already written;
 * losing the enrichment costs accuracy on this run, and the next refresh will
 * try again. Errors are recorded in `data_errors` and returned to the caller.
 */
import { fetchParcelsForPoints, fetchZoningForPoints } from "../arcgis";
import { ringsToMultiPolygon, parcelAttrs } from "../gis/parcel";
import { upsertZoningDistricts } from "../gis/zoning";
import { distinctPoints } from "./geolocate";
import proj4 from "proj4";

export type GisCacheResult = { parcels: number; zoning: number; errors: string[] };

export type CacheTarget = { lng: number; lat: number };

export type CacheJurisdiction = {
  id: string;
  gis_parcel_url: string | null;
  gis_zoning_url: string | null;
};

export type CacheMarket = { proj4: string; srid_feet: number };

export async function cacheGisForPoints(
  db: any,
  jurisdiction: CacheJurisdiction,
  market: CacheMarket,
  points: CacheTarget[],
): Promise<GisCacheResult> {
  const result: GisCacheResult = { parcels: 0, zoning: 0, errors: [] };
  const pts = distinctPoints(points);
  if (!pts.length) return result;

  const projected = pts.map((p) => {
    const [x, y] = proj4("EPSG:4326", market.proj4, [p.lng, p.lat]) as [number, number];
    return { x, y };
  });
  const now = new Date().toISOString();

  const note = async (message: string) => {
    result.errors.push(message);
    try {
      await db.from("data_errors").insert({
        category: "gis", entity: "listings", entity_id: jurisdiction.id, message,
      });
    } catch { /* the import is not worth failing over a log row */ }
  };

  // ── parcels ──────────────────────────────────────────────────────────────
  if (jurisdiction.gis_parcel_url) {
    try {
      const parcels = await fetchParcelsForPoints(jurisdiction.gis_parcel_url, projected, market.srid_feet);
      const rows = parcels.map((p) => {
        const { pvaId, acreage } = parcelAttrs(p.attrs as any);
        return {
          jurisdiction_id: jurisdiction.id, source_object_id: p.objectId,
          address: p.address || null, geom: ringsToMultiPolygon(p.rings),
          attrs: p.attrs, fetched_at: now, pva_id: pvaId, acreage,
        };
      });
      for (let i = 0; i < rows.length; i += 200) {
        const { error } = await db.from("parcels")
          .upsert(rows.slice(i, i + 200), { onConflict: "jurisdiction_id,source_object_id" });
        if (error) { await note(`Caching parcels failed: ${error.message}`); break; }
        result.parcels += rows.slice(i, i + 200).length;
      }
    } catch (e: any) {
      await note(`Parcel fetch failed: ${e.message}`);
    }
  }

  // ── zoning ───────────────────────────────────────────────────────────────
  if (jurisdiction.gis_zoning_url) {
    try {
      const districts = await fetchZoningForPoints(jurisdiction.gis_zoning_url, projected, market.srid_feet);
      const rows = districts.map((z) => ({
        jurisdiction_id: jurisdiction.id, source_object_id: z.objectId,
        zone_code: z.zone, ordinance_url: z.link,
        geom: ringsToMultiPolygon(z.rings), fetched_at: now,
      }));
      // not an upsert: zoning_districts_uniq is partial — see gis/zoning.ts
      const { written, error } = await upsertZoningDistricts(db, rows);
      result.zoning = written;
      if (error) await note(`Caching zoning failed: ${error}`);
    } catch (e: any) {
      await note(`Zoning fetch failed: ${e.message}`);
    }
  }

  return result;
}
