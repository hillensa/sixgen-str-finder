import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient, requireAdminOrSecret, errStatus, audit } from "@/lib/supabase/admin";
import { fetchStrPermits, fetchParcelsForPoints } from "@/lib/arcgis";
import { ringsToMultiPolygon, parcelAttrs } from "@/lib/gis/parcel";
import { normalizeAddress } from "@/lib/address";
import proj4 from "proj4";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/refresh?jurisdiction=lfucg
 * Sync city STR layer → str_permits (source='city_gis'), match parcels,
 * re-derive the blocking flag from str_rules, rebuild the exclusion in PostGIS.
 */
export async function POST(req: Request) {
  const s = createClient(); let actor: string | null;
  try { ({ actor } = await requireAdminOrSecret(req, s)); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: errStatus(e) }); }
  const jid = new URL(req.url).searchParams.get("jurisdiction") ?? "lfucg";
  const db = createAdminClient(); const t0 = Date.now();
  const { data: j } = await db.from("jurisdictions").select("*, markets(*)").eq("id", jid).single();
  if (!j?.gis_str_url || !j?.gis_parcel_url) return NextResponse.json({ error: "Jurisdiction GIS endpoints not configured" }, { status: 400 });
  const market = (j as any).markets;
  const toWgs = (x: number, y: number) => proj4(market.proj4, "EPSG:4326", [x, y]) as [number, number];

  // 1. permits — outSR pinned to the market SRID so proj4 and the layer agree
  const permits = await fetchStrPermits(j.gis_str_url, market.srid_feet);
  if (!permits.length) return NextResponse.json({ error: "City STR layer returned no records — refusing to rebuild the exclusion from an empty pull." }, { status: 502 });

  const unclassified = permits.filter((p) => p.strType === null);
  const now = new Date().toISOString();
  const rows = permits.map((p) => {
    const located = p.x != null && p.y != null;
    const [lng, lat] = located ? toWgs(p.x as number, p.y as number) : [null, null];
    return {
      jurisdiction_id: jid, external_id: p.externalId, permit_number: p.license || null,
      address_raw: p.address, address_norm: normalizeAddress(p.address),
      str_type: p.strType,
      // The public layer publishes no status field. 'unknown' is the honest
      // value, and the seeded blocking rule counts unknown as blocking, so a
      // missing status can never read as "clear".
      permit_status: "unknown",
      review_note: p.strType === null ? `Layer value "${p.hostedRaw}" is not a recognized hosted/un-hosted code — treated as blocking pending review.` : null,
      lat, lng,
      source: "city_gis", source_updated_at: now, geocode_method: located ? "gis_point" : null,
      address_confidence: located ? 1 : null, updated_at: now,
    };
  });
  // match_status / match_method / is_blocking are intentionally NOT written here:
  // re-syncing used to reset every matched permit back to 'unmatched' and wipe
  // manual corrections. They are owned by fn_link_permits_to_parcels and
  // fn_apply_blocking_rules below.
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db.from("str_permits").upsert(rows.slice(i, i + 500), { onConflict: "jurisdiction_id,source,external_id" });
    if (error) return NextResponse.json({ error: `permits: ${error.message}` }, { status: 500 });
  }

  // 1b. records that vanished from the layer keep blocking, but are flagged
  const seen = new Set(rows.map((r) => r.external_id));
  const { data: existing } = await db.from("str_permits").select("id,external_id,review_note").eq("jurisdiction_id", jid).eq("source", "city_gis");
  const dropped = (existing ?? []).filter((r: any) => !seen.has(r.external_id));
  if (dropped.length) {
    await db.from("str_permits")
      .update({ review_note: `No longer present in the LFUCG layer as of ${now.slice(0, 10)} — status unverified, still counted as blocking.`, updated_at: now })
      .in("id", dropped.map((r: any) => r.id));
  }

  // 2. parcels for every located permit that could block (un-hosted or unclassified)
  const needParcel = permits.filter((p) => p.strType !== "hosted" && p.x != null && p.y != null);
  const parcels = await fetchParcelsForPoints(j.gis_parcel_url, needParcel.map((p) => ({ x: p.x as number, y: p.y as number })), market.srid_feet);
  const parcelRows = parcels.map((p) => {
    const { pvaId, acreage } = parcelAttrs(p.attrs);
    return {
      jurisdiction_id: jid, source_object_id: p.objectId, address: p.address || null,
      geom: ringsToMultiPolygon(p.rings), attrs: p.attrs, fetched_at: now,
      pva_id: pvaId, acreage,
    };
  });
  for (let i = 0; i < parcelRows.length; i += 200) {
    const { error } = await db.from("parcels").upsert(parcelRows.slice(i, i + 200), { onConflict: "jurisdiction_id,source_object_id" });
    if (error) return NextResponse.json({ error: `parcels: ${error.message}` }, { status: 500 });
  }

  // 3. link permits → parcels spatially (single SQL pass; never clobbers manual)
  const { data: linked } = await db.rpc("fn_link_permits_to_parcels", { p_jurisdiction: jid });

  // 4. derive is_blocking from str_rules, then rebuild the exclusion
  const { data: blk, error: blkErr } = await db.rpc("fn_apply_blocking_rules", { p_jurisdiction: jid });
  if (blkErr) return NextResponse.json({ error: `blocking rules: ${blkErr.message}` }, { status: 500 });
  const blocking = blk?.[0]?.blocking ?? 0;
  if (!blocking) {
    return NextResponse.json({
      error: "No permit qualified as blocking under the current rules, so the 600-ft exclusion would be empty. Check Admin → STR Rules (spacing_ft, blocking_permit_statuses) before rebuilding.",
      permits: rows.length, unclassified: unclassified.length,
    }, { status: 409 });
  }
  const { data: ex, error: exErr } = await db.rpc("fn_rebuild_exclusions", { p_jurisdiction: jid });
  if (exErr) return NextResponse.json({ error: `exclusion: ${exErr.message}` }, { status: 500 });

  const unlocated = rows.filter((r) => r.lat == null).length;
  const message = `${blocking} blocking · ${unclassified.length} unclassified type · ${unlocated} unlocated · ${parcels.length} parcels${dropped.length ? ` · ${dropped.length} dropped from layer` : ""}`;
  await db.from("imports").insert({ kind: "str_permits", market_id: market.id, file_name: "LFUCG GIS layer", row_count: rows.length, matched: parcels.length, status: "complete", actor, message, completed_at: new Date().toISOString() });
  await audit(db, actor, "gis.refresh", "jurisdiction", jid, { permits: rows.length, parcels: parcels.length, blocking, unclassified: unclassified.length, unlocated, dropped: dropped.length, ms: Date.now() - t0 });

  return NextResponse.json({
    ok: true, permits: rows.length, blocking, unclassified: unclassified.length, unlocated,
    parcels: parcels.length, linked: linked ?? 0, dropped: dropped.length,
    exclusion: ex?.[0] ?? null, elapsedMs: Date.now() - t0,
  });
}
