import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient, requireAdmin, errStatus, audit } from "@/lib/supabase/admin";
import { readUploadedFile, bufferFromForm } from "@/lib/import/readFile";
import { validateMapping, type ColumnMapping } from "@/lib/import/columns";
import { normalizePermitRows, matchStatusFor, type NormalizedPermit } from "@/lib/import/permits";
import { geocodeMany, geocodeKey } from "@/lib/geocode";
import { fetchParcelsForPoints } from "@/lib/arcgis";
import { ringsToMultiPolygon, parcelAttrs } from "@/lib/gis/parcel";
import proj4 from "proj4";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/imports/permits/commit
 *   multipart: file, mapping (JSON), jurisdiction?, sheet?, headerRow?, source?,
 *              useCensus?, rebuild?
 *
 * Step 2 of the wizard: normalize → geocode → parcel match → write permits →
 * re-derive blocking flags → rebuild the 600-ft exclusion.
 *
 * Every row is persisted to `import_rows` with its raw content and its outcome,
 * so the match report can explain, per row, why it landed where it did.
 */
export async function POST(req: Request) {
  const s = createClient(); let user;
  try { user = await requireAdmin(s); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: errStatus(e) }); }

  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "Expected a multipart upload." }, { status: 400 });
  const got = await bufferFromForm(form);
  if ("error" in got) return NextResponse.json({ error: got.error }, { status: 400 });

  let mapping: ColumnMapping;
  try { mapping = JSON.parse(String(form.get("mapping") ?? "{}")); }
  catch { return NextResponse.json({ error: "mapping must be JSON." }, { status: 400 }); }

  const jid = String(form.get("jurisdiction") || "lfucg");
  const source = String(form.get("source") || "file");
  const useCensus = String(form.get("useCensus") ?? "true") !== "false";
  const rebuild = String(form.get("rebuild") ?? "true") !== "false";
  const sheetField = String(form.get("sheet") ?? "");
  const headerRow = Number(form.get("headerRow") ?? 1) || 1;

  const db = createAdminClient(); const t0 = Date.now();
  const { data: j } = await db.from("jurisdictions").select("*, markets(*)").eq("id", jid).single();
  if (!j) return NextResponse.json({ error: `Jurisdiction ${jid} not found` }, { status: 404 });
  const market = (j as any).markets;

  let file;
  try { file = readUploadedFile(got.buf, { sheet: sheetField === "" ? undefined : (/^\d+$/.test(sheetField) ? Number(sheetField) : sheetField), headerRow }); }
  catch (e: any) { return NextResponse.json({ error: e.message }, { status: 400 }); }

  const mapErrors = validateMapping(mapping, file.headers);
  if (mapErrors.length) return NextResponse.json({ error: "Column mapping is not usable.", errors: mapErrors }, { status: 400 });

  const { rows: norm, counts } = normalizePermitRows(file.rows, mapping);
  if (!counts.ready) return NextResponse.json({ error: "No importable rows — every row was invalid or a duplicate.", counts }, { status: 400 });

  // ── import header ────────────────────────────────────────────────────────
  const { data: imp, error: impErr } = await db.from("imports").insert({
    kind: "str_permits", market_id: market.id, file_name: `${got.name}${file.sheetName ? ` · ${file.sheetName}` : ""}`,
    column_mapping: { mapping, headerRow, sheet: file.sheetName, source },
    row_count: norm.length, invalid: counts.invalid, duplicates: counts.duplicate,
    status: "processing", actor: user.id,
  }).select("id").single();
  if (impErr || !imp) return NextResponse.json({ error: `Could not open the import: ${impErr?.message}` }, { status: 500 });
  const importId = imp.id as number;

  const fail = async (message: string, status = 500) => {
    await db.from("imports").update({ status: "failed", message, completed_at: new Date().toISOString() }).eq("id", importId);
    return NextResponse.json({ error: message, importId }, { status });
  };

  // ── per-row provenance ───────────────────────────────────────────────────
  const rowIdByNumber = new Map<number, number>();
  for (let i = 0; i < norm.length; i += 500) {
    const chunk = norm.slice(i, i + 500).map((r) => ({
      import_id: importId, row_number: r.rowNumber, raw: r.raw,
      normalized: {
        addressRaw: r.addressRaw, addressNorm: r.addressNorm, unit: r.unit, zip: r.zip,
        permitNumber: r.permitNumber, owner: r.owner, strType: r.strType, permitStatus: r.permitStatus,
        issueDate: r.issueDate, expirationDate: r.expirationDate, externalId: r.externalId,
      },
      status: r.status, target_table: "str_permits",
      error: r.errors.length ? r.errors.join(" ") : null,
    }));
    const { data, error } = await db.from("import_rows").insert(chunk).select("id,row_number");
    if (error) return fail(`Writing import rows failed: ${error.message}`);
    for (const d of data ?? []) rowIdByNumber.set(d.row_number, d.id);
  }

  // ── geocode ──────────────────────────────────────────────────────────────
  const ready = norm.filter((r) => r.status === "ready");
  const needGeocode = ready.filter((r) => r.lat == null);
  let geo = new Map<string, any>();
  try {
    geo = await geocodeMany(db, j as any, needGeocode.map((r) => ({ address: r.addressRaw, zip: r.zip })), { useCensus, concurrency: 6 });
  } catch (e: any) {
    return fail(`Geocoding failed: ${e.message}`, 502);
  }

  const resolve = (r: NormalizedPermit) => {
    if (r.lat != null && r.lng != null) return { lat: r.lat, lng: r.lng, confidence: 1, method: "file_coordinates" as const, matched: r.addressNorm };
    const g = geo.get(geocodeKey(r.addressRaw));
    return g ? { lat: g.lat, lng: g.lng, confidence: g.confidence, method: g.method, matched: g.matchedAddress } : null;
  };

  // ── permits ──────────────────────────────────────────────────────────────
  // match_status here reflects only how well the ADDRESS resolved. The parcel
  // link is decided afterwards by fn_link_permits_to_parcels in PostGIS.
  const permitRows = ready.map((r) => {
    const g = resolve(r);
    return {
      jurisdiction_id: jid, import_id: importId, import_row_id: rowIdByNumber.get(r.rowNumber) ?? null,
      external_id: r.externalId, permit_number: r.permitNumber,
      owner: r.owner, address_raw: r.addressRaw, address_norm: r.addressNorm, unit: r.unit, zip: r.zip,
      str_type: r.strType, permit_status: r.permitStatus,
      issue_date: r.issueDate, expiration_date: r.expirationDate,
      lat: g?.lat ?? null, lng: g?.lng ?? null,
      address_confidence: g?.confidence ?? null, geocode_method: g?.method ?? null,
      match_status: matchStatusFor(g?.confidence ?? null, !!g),
      match_confidence: g?.confidence ?? null,
      match_method: g ? (g.method === "file_coordinates" ? "gis_point" : "address_point") : null,
      review_note: r.strType === null ? "Hosted/un-hosted not classifiable from the file — treated as blocking pending review." : null,
      source, source_updated_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
  });

  const permitIdByExternal = new Map<string, number>();
  for (let i = 0; i < permitRows.length; i += 400) {
    const { data, error } = await db.from("str_permits")
      .upsert(permitRows.slice(i, i + 400), { onConflict: "jurisdiction_id,source,external_id" })
      .select("id,external_id");
    if (error) return fail(`Writing permits failed: ${error.message}`);
    for (const d of data ?? []) permitIdByExternal.set(d.external_id, d.id);
  }

  // link duplicates to the row they duplicate, so the report can show the pair
  const dupUpdates = norm.filter((r) => r.status === "duplicate" && r.duplicateOfRow != null);
  for (const d of dupUpdates) {
    const keeper = norm.find((r) => r.rowNumber === d.duplicateOfRow);
    const keeperId = keeper ? permitIdByExternal.get(keeper.externalId) : null;
    const rowId = rowIdByNumber.get(d.rowNumber);
    if (rowId) await db.from("import_rows").update({ target_id: keeperId ?? null }).eq("id", rowId);
  }
  for (const r of ready) {
    const rowId = rowIdByNumber.get(r.rowNumber); const pid = permitIdByExternal.get(r.externalId);
    if (rowId && pid) await db.from("import_rows").update({ target_id: pid, status: permitRows.find((p) => p.external_id === r.externalId)?.match_status ?? "unmatched" }).eq("id", rowId);
  }

  // ── parcels for everything we located ────────────────────────────────────
  let parcelCount = 0;
  const located = permitRows.filter((p) => p.lat != null && p.lng != null);
  if (located.length && j.gis_parcel_url) {
    const toSrid = (lng: number, lat: number) => proj4("EPSG:4326", market.proj4, [lng, lat]) as [number, number];
    const pts = located.map((p) => { const [x, y] = toSrid(p.lng as number, p.lat as number); return { x, y }; });
    try {
      const parcels = await fetchParcelsForPoints(j.gis_parcel_url, pts, market.srid_feet);
      const parcelRows = parcels.map((p) => ({
        jurisdiction_id: jid, source_object_id: p.objectId, address: p.address || null,
        geom: ringsToMultiPolygon(p.rings), attrs: p.attrs, fetched_at: new Date().toISOString(),
        pva_id: parcelAttrs(p.attrs).pvaId, acreage: parcelAttrs(p.attrs).acreage,
      }));
      for (let i = 0; i < parcelRows.length; i += 200) {
        const { error } = await db.from("parcels").upsert(parcelRows.slice(i, i + 200), { onConflict: "jurisdiction_id,source_object_id" });
        if (error) return fail(`Writing parcels failed: ${error.message}`);
      }
      parcelCount = parcelRows.length;
    } catch (e: any) {
      await db.from("data_errors").insert({ category: "gis", entity: "imports", entity_id: String(importId), message: `Parcel fetch failed: ${e.message}` });
    }
  }

  // ── spatial link, blocking rules, exclusion ──────────────────────────────
  await db.rpc("fn_link_permits_to_parcels", { p_jurisdiction: jid });
  const { data: blk, error: blkErr } = await db.rpc("fn_apply_blocking_rules", { p_jurisdiction: jid });
  if (blkErr) return fail(`Applying blocking rules failed: ${blkErr.message}`);

  let exclusion: any = null;
  if (rebuild) {
    const { data: ex, error: exErr } = await db.rpc("fn_rebuild_exclusions", { p_jurisdiction: jid });
    if (exErr) return fail(`Rebuilding the exclusion zone failed: ${exErr.message}`);
    exclusion = ex?.[0] ?? null;
  }

  const { data: report } = await db.rpc("fn_permit_match_report", { p_jurisdiction: jid });
  const matched = permitRows.filter((p) => p.match_status === "matched").length;
  const possible = permitRows.filter((p) => p.match_status === "possible").length;
  const unmatched = permitRows.filter((p) => p.match_status === "unmatched").length;
  const message = `${matched} matched · ${possible} possible · ${unmatched} unmatched · ${counts.duplicate} duplicate · ${counts.invalid} invalid · ${counts.unclassified} unclassified type`;

  await db.from("imports").update({
    status: "complete", matched, possible, unmatched, duplicates: counts.duplicate, invalid: counts.invalid,
    message, completed_at: new Date().toISOString(),
  }).eq("id", importId);
  await audit(db, user.id, "permits.import", "imports", importId, { rows: norm.length, matched, possible, unmatched, parcels: parcelCount, ms: Date.now() - t0 });

  return NextResponse.json({
    ok: true, importId, counts: { ...counts, matched, possible, unmatched },
    parcels: parcelCount, blocking: blk?.[0] ?? null, exclusion, report: report ?? [],
    elapsedMs: Date.now() - t0,
  });
}
