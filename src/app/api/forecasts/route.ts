import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient, requireAdminOrSecret, errStatus, audit } from "@/lib/supabase/admin";
import { buildForecast, type CompProperty, type Subject } from "@/lib/comps/engine";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const BATCH = 200;

/** Map an fn_sixgen_t12 row onto the engine's comp shape. */
const toComp = (r: any): CompProperty => ({
  id: r.sixgen_property_id, name: r.name,
  beds: r.beds, baths: r.baths == null ? null : Number(r.baths), maxGuests: r.max_guests,
  hotTub: r.hot_tub, golfSim: r.golf_sim, gameRoom: r.game_room,
  pool: r.pool, firePit: r.fire_pit, poolTable: r.pool_table,
  adr: r.adr == null ? null : Number(r.adr),
  occupancy: r.occupancy == null ? null : Number(r.occupancy),
  grossRevenue: r.gross_revenue == null ? null : Number(r.gross_revenue),
  monthsWithData: r.months_with_data,
  isPartialYear: r.is_partial_year,
});

async function loadContext(db: any, jurisdictionId = "lfucg") {
  const [{ data: pool }, { data: seasonality }, { data: cap }] = await Promise.all([
    db.rpc("fn_sixgen_t12"),
    db.rpc("fn_sixgen_seasonality", { p_beds_min: null, p_beds_max: null }),
    db.rpc("fn_rule_num", { p_jurisdiction: jurisdictionId, p_key: "occupancy_ceiling", p_zone: null, p_str_type: null }),
  ]);
  const shape = (seasonality ?? []).length === 12
    ? (seasonality as any[]).map((s) => ({ month: s.month, adrIndex: Number(s.adr_index) }))
    : undefined;
  return {
    comps: (pool ?? []).map(toComp) as CompProperty[],
    seasonality: shape,
    occupancyCap: cap == null ? 0.82 : Number(cap),
  };
}

/**
 * POST /api/forecasts?market=lexington-ky[&propertyIds=1,2]
 *
 * Runs the Sixgen comparable engine over the market's properties and writes
 * `revenue_forecasts` (three scenarios each) plus the `comparable_matches` that
 * produced them, stamped with the model version.
 */
export async function POST(req: Request) {
  const s = createClient(); let actor: string | null;
  try { ({ actor } = await requireAdminOrSecret(req, s)); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: errStatus(e) }); }

  const u = new URL(req.url);
  const marketId = u.searchParams.get("market") ?? "lexington-ky";
  const idsParam = u.searchParams.get("propertyIds");
  const db = createAdminClient(); const t0 = Date.now();

  const ctx = await loadContext(db);
  if (!ctx.comps.length) {
    return NextResponse.json({ error: "No Sixgen trailing-twelve data is loaded, so there is nothing to compare against. Import the portfolio first." }, { status: 409 });
  }

  let query = db.from("v_listings_enriched")
    .select("property_id,beds,baths,list_price,pool,address")
    .eq("market_id", marketId).is("removed_at", null);
  if (idsParam) {
    const ids = idsParam.split(",").map((x) => Number(x.trim())).filter((n) => Number.isFinite(n));
    if (!ids.length) return NextResponse.json({ error: "propertyIds contained no usable ids" }, { status: 400 });
    query = query.in("property_id", ids);
  }
  const { data: subjects, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!subjects?.length) {
    return NextResponse.json({ ok: true, market: marketId, forecast: 0, message: "No listings to forecast yet — run a listings refresh first.", elapsedMs: Date.now() - t0 });
  }

  // one property may carry several listings; forecast the property once
  const byProperty = new Map<number, any>();
  for (const r of subjects) if (!byProperty.has(r.property_id)) byProperty.set(r.property_id, r);

  const forecastRows: any[] = [];
  const compRows: any[] = [];
  const confidence: Record<string, number> = { HIGH: 0, MEDIUM: 0, LOW: 0 };
  let noComps = 0;

  for (const [propertyId, r] of byProperty) {
    const subject: Subject = {
      beds: r.beds, baths: r.baths == null ? null : Number(r.baths),
      maxGuests: r.beds ? r.beds * 2 : null,   // max_guests_per_bedroom rule; refined when a listing states it
      pool: r.pool === true,
      price: r.list_price,
    };
    const f = buildForecast(subject, ctx.comps, {
      occupancyCap: ctx.occupancyCap, seasonality: ctx.seasonality,
    });
    confidence[f.confidence] = (confidence[f.confidence] ?? 0) + 1;
    if (!f.compCount) { noComps++; continue; }

    for (const scenario of ["conservative", "base", "upside"] as const) {
      const sc = f.scenarios[scenario];
      forecastRows.push({
        property_id: propertyId, model_version: f.modelVersion, scenario,
        adr: sc.adr, occupancy: sc.occupancy, available_nights: 365,
        annual_revenue: sc.revenue,
        monthly: scenario === "base" ? f.monthly : null,
        confidence: f.confidence, confidence_reasons: f.confidenceReasons,
        comp_count: f.compCount, comp_coverage: f.coverage,
        occupancy_cap: f.occupancyCap, basis: "sixgen_t12",
        listing_price: r.list_price ?? null,
        gross_yield_pct: r.list_price ? +((sc.revenue / r.list_price) * 100).toFixed(1) : null,
      });
    }
    f.comps.forEach((c, i) => compRows.push({
      property_id: propertyId, sixgen_property_id: c.comp.id, model_version: f.modelVersion,
      similarity: c.similarity, weight: c.weight, reasons: c.reasons, rank: i + 1,
      adr: c.comp.adr, occupancy: c.comp.occupancy, gross_revenue: c.comp.grossRevenue,
      months_with_data: c.comp.monthsWithData,
    }));
  }

  for (let i = 0; i < forecastRows.length; i += BATCH) {
    const { error: e } = await db.from("revenue_forecasts").insert(forecastRows.slice(i, i + BATCH));
    if (e) return NextResponse.json({ error: `writing forecasts: ${e.message}` }, { status: 500 });
  }
  for (let i = 0; i < compRows.length; i += BATCH) {
    const { error: e } = await db.from("comparable_matches").insert(compRows.slice(i, i + BATCH));
    if (e) return NextResponse.json({ error: `writing comparables: ${e.message}` }, { status: 500 });
  }

  const forecast = forecastRows.length / 3;
  const message = `${forecast} properties forecast · ${confidence.HIGH} high · ${confidence.MEDIUM} medium · ${confidence.LOW} low confidence${noComps ? ` · ${noComps} had no usable comparable` : ""}`;
  await audit(db, actor, "forecasts.run", "market", marketId, { forecast, confidence, noComps, ms: Date.now() - t0 });

  return NextResponse.json({
    ok: true, market: marketId, forecast, noComps, confidence, message,
    modelVersion: forecastRows[0]?.model_version ?? null,
    occupancyCap: ctx.occupancyCap, compPoolSize: ctx.comps.length,
    elapsedMs: Date.now() - t0,
  });
}

/**
 * GET /api/forecasts?beds=5&baths=3&maxGuests=12&pool=1&price=750000
 * An ad-hoc forecast for a hypothetical property — nothing written. This is what
 * the Sixgen Comps page uses.
 */
export async function GET(req: Request) {
  const s = createClient();
  const { data: { user } } = await s.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const p = new URL(req.url).searchParams;
  const num = (k: string) => { const v = Number(p.get(k)); return Number.isFinite(v) && p.get(k) !== null && p.get(k) !== "" ? v : null; };
  const flag = (k: string) => p.get(k) === "1" || p.get(k) === "true";

  const ctx = await loadContext(s);
  if (!ctx.comps.length) return NextResponse.json({ error: "No Sixgen trailing-twelve data is loaded yet." }, { status: 409 });

  const beds = num("beds");
  if (beds == null) return NextResponse.json({ error: "beds is required — it is the primary comparable attribute." }, { status: 400 });

  const subject: Subject = {
    beds, baths: num("baths"), maxGuests: num("maxGuests") ?? beds * 2,
    hotTub: flag("hotTub"), golfSim: flag("golfSim"), gameRoom: flag("gameRoom"),
    pool: flag("pool"), firePit: flag("firePit"), poolTable: flag("poolTable"),
    price: num("price"),
  };
  const forecast = buildForecast(subject, ctx.comps, { occupancyCap: ctx.occupancyCap, seasonality: ctx.seasonality });
  const { data: portfolio } = await s.rpc("fn_sixgen_portfolio_summary");

  return NextResponse.json({ subject, forecast, portfolio: portfolio?.[0] ?? null, compPoolSize: ctx.comps.length });
}
