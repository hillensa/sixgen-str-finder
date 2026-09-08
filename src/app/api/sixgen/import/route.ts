import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient, requireAdminOrSecret, errStatus, audit } from "@/lib/supabase/admin";
import { readUploadedFile, bufferFromForm } from "@/lib/import/readFile";
import { normalizeSixgenProperties, normalizeSixgenMonthly, sixgenImportWarnings,
         monthlyKey, changedMonthlyRows } from "@/lib/import/sixgen";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/sixgen/import   (multipart: properties?, monthly?, kind?)
 *
 * Loads the Guesty portfolio export. Properties are upserted on guesty_id;
 * monthly rows are appended under a new import_id so history is preserved and
 * the comp engine reads only the newest reading per listing-month.
 */
export async function POST(req: Request) {
  // Accepts an admin session OR the IMPORT_SECRET bearer token, like the other
  // bulk loads. The runbook tells operators to run long imports from a machine;
  // this endpoint refusing the token was an inconsistency, not a boundary.
  const s = createClient(); let actor: string | null;
  try { ({ actor } = await requireAdminOrSecret(req, s)); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: errStatus(e) }); }

  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "Expected a multipart upload." }, { status: 400 });

  const propFile = form.get("properties");
  const monthlyFile = form.get("monthly");
  if (!propFile && !monthlyFile) return NextResponse.json({ error: "Upload a properties file, a monthly file, or both." }, { status: 400 });

  const db = createAdminClient(); const t0 = Date.now();
  const marketId = String(form.get("market") || "lexington-ky");

  const { data: imp } = await db.from("imports").insert({
    kind: "sixgen", market_id: marketId, status: "processing", actor,
    file_name: [propFile && (propFile as File).name, monthlyFile && (monthlyFile as File).name].filter(Boolean).join(" + "),
  }).select("id").single();
  const importId: number = imp?.id ?? 0;
  const fail = async (message: string, status = 500) => {
    if (importId) await db.from("imports").update({ status: "failed", message, completed_at: new Date().toISOString() }).eq("id", importId);
    return NextResponse.json({ error: message, importId }, { status });
  };

  let propRows: ReturnType<typeof normalizeSixgenProperties>["rows"] = [];
  let monthRows: ReturnType<typeof normalizeSixgenMonthly>["rows"] = [];
  const parseErrors: string[] = [];

  if (propFile) {
    const got = await bufferFromForm(form, "properties");
    if ("error" in got) return fail(got.error, 400);
    try {
      const file = readUploadedFile(got.buf);
      const n = normalizeSixgenProperties(file.rows);
      propRows = n.rows; parseErrors.push(...n.errors);
    } catch (e: any) { return fail(`properties file: ${e.message}`, 400); }
  }
  if (monthlyFile) {
    const got = await bufferFromForm(form, "monthly");
    if ("error" in got) return fail(got.error, 400);
    try {
      const file = readUploadedFile(got.buf);
      const n = normalizeSixgenMonthly(file.rows);
      monthRows = n.rows; parseErrors.push(...n.errors);
    } catch (e: any) { return fail(`monthly file: ${e.message}`, 400); }
  }

  // ── properties ───────────────────────────────────────────────────────────
  let propsWritten = 0;
  for (const p of propRows) {
    const row = {
      market_id: marketId, guesty_id: p.guestyId, name: p.name, address: p.address,
      zip: p.zip, lat: p.lat, lng: p.lng, beds: p.beds, baths: p.baths, max_guests: p.maxGuests,
      property_type: p.propertyType, active: p.active,
      hot_tub: p.hotTub, golf_sim: p.golfSim, game_room: p.gameRoom,
      pool: p.pool, fire_pit: p.firePit, pool_table: p.poolTable,
      amenities: p.amenities, external_ids: p.guestyId ? { guesty: p.guestyId } : null,
      notes: p.errors.length ? p.errors.join(" ") : null,
      updated_at: new Date().toISOString(),
    };
    // Look the listing up, then insert or update. No ON CONFLICT: the uniqueness
    // guarantee on guesty_id is a PARTIAL index (`where guesty_id is not null`),
    // and Postgres will not accept a partial index as a conflict target.
    const { data: existing } = p.guestyId
      ? await db.from("sixgen_properties").select("id").eq("guesty_id", p.guestyId).maybeSingle()
      : await db.from("sixgen_properties").select("id").eq("market_id", marketId).eq("name", p.name).maybeSingle();

    const { error } = existing
      ? await db.from("sixgen_properties").update(row).eq("id", existing.id)
      : await db.from("sixgen_properties").insert(row);
    if (error) return fail(`writing ${p.name}: ${error.message}`);
    propsWritten++;
  }

  // ── monthly ──────────────────────────────────────────────────────────────
  let monthsWritten = 0, monthsUnchanged = 0; const unmatched: string[] = [];
  if (monthRows.length) {
    const { data: all } = await db.from("sixgen_properties").select("id,guesty_id,name").eq("market_id", marketId);
    const byGuesty = new Map((all ?? []).filter((r: any) => r.guesty_id).map((r: any) => [r.guesty_id, r.id]));
    const byName = new Map((all ?? []).map((r: any) => [String(r.name).toUpperCase(), r.id]));

    const payload = monthRows.map((m) => {
      const id = (m.guestyId && byGuesty.get(m.guestyId)) ?? byName.get(m.name.toUpperCase());
      if (!id) { unmatched.push(m.name); return null; }
      return {
        sixgen_property_id: id, year: m.year, month: m.month, import_id: importId,
        reservations: m.reservations, occupied_nights: m.occupiedNights, available_nights: m.availableNights,
        occupancy: m.occupancy, adr: m.adr, revpar: m.revpar, gross_revenue: m.grossRevenue,
        source: "guesty",
      };
    }).filter(Boolean) as any[];

    // Only write readings that are new or actually different. Re-running an
    // unchanged export used to append a full duplicate generation every time.
    const ids = [...new Set(payload.map((p) => p.sixgen_property_id))];
    const { data: stored } = await db.from("sixgen_monthly_performance")
      .select("sixgen_property_id,year,month,import_id,reservations,occupied_nights,available_nights,occupancy,adr,revpar,gross_revenue")
      .in("sixgen_property_id", ids);

    const newest = new Map<string, any>();
    for (const r of stored ?? []) {
      const k = monthlyKey(r.sixgen_property_id, r.year, r.month);
      const prev = newest.get(k);
      if (!prev || (r.import_id ?? 0) > (prev.import_id ?? 0)) newest.set(k, r);
    }

    const toWrite = changedMonthlyRows(payload, newest);
    monthsUnchanged = payload.length - toWrite.length;

    for (let i = 0; i < toWrite.length; i += 500) {
      const { error } = await db.from("sixgen_monthly_performance")
        .upsert(toWrite.slice(i, i + 500), { onConflict: "sixgen_property_id,year,month,import_id" });
      if (error) return fail(`writing monthly performance: ${error.message}`);
      monthsWritten += toWrite.slice(i, i + 500).length;
    }
  }

  const warnings = sixgenImportWarnings(propRows, monthRows);
  const { data: portfolio } = await db.rpc("fn_sixgen_portfolio_summary");
  const message = `${propsWritten} listings · ${monthsWritten} listing-months${monthsUnchanged ? ` · ${monthsUnchanged} unchanged` : ""}${unmatched.length ? ` · ${new Set(unmatched).size} unmatched` : ""}`;

  await db.from("imports").update({
    status: "complete", row_count: propRows.length + monthRows.length,
    matched: propsWritten + monthsWritten, unmatched: new Set(unmatched).size,
    message, completed_at: new Date().toISOString(),
  }).eq("id", importId);
  await audit(db, actor, "sixgen.import", "imports", importId, { propsWritten, monthsWritten, ms: Date.now() - t0 });

  return NextResponse.json({
    ok: true, importId, propsWritten, monthsWritten, monthsUnchanged,
    unmatched: [...new Set(unmatched)].slice(0, 20),
    parseErrors: parseErrors.slice(0, 20), warnings,
    portfolio: portfolio?.[0] ?? null,
    elapsedMs: Date.now() - t0,
  });
}

/** GET /api/sixgen/import — the current portfolio and its trailing-twelve figures. */
export async function GET() {
  const s = createClient();
  const { data: { user } } = await s.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const [{ data: t12 }, { data: summary }, { data: seasonality }] = await Promise.all([
    s.rpc("fn_sixgen_t12"),
    s.rpc("fn_sixgen_portfolio_summary"),
    s.rpc("fn_sixgen_seasonality", { p_beds_min: null, p_beds_max: null }),
  ]);
  return NextResponse.json({ t12: t12 ?? [], portfolio: summary?.[0] ?? null, seasonality: seasonality ?? [] });
}
