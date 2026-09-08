import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient, requireAdminOrSecret, errStatus, audit } from "@/lib/supabase/admin";
import { scoreCandidates, type Candidate, type Weight, type DemandPoint } from "@/lib/scoring/score";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const BATCH = 200;

const toCandidate = (r: any): Candidate => ({
  propertyId: r.property_id, address: r.address,
  listPrice: r.list_price == null ? null : Number(r.list_price),
  beds: r.beds, baths: r.baths == null ? null : Number(r.baths),
  sqft: r.sqft, lotSqft: r.lot_sqft,
  basement: r.basement, finishedBasement: r.finished_basement,
  pool: r.pool, garage: r.garage, lat: r.lat, lng: r.lng,
  hoaStatus: r.hoa_status, classification: r.classification,
  eligibilitySummary: r.eligibility_summary,
  forecastRevenue: r.forecast_revenue == null ? null : Number(r.forecast_revenue),
  forecastConfidence: r.forecast_confidence,
  compCount: r.comp_count,
  compCoverage: r.comp_coverage == null ? null : Number(r.comp_coverage),
  status: r.status,
});

/**
 * POST /api/scores?market=lexington-ky
 *
 * Ranks the market. Eligibility gates: a RED property is recorded with its gate
 * reason and no score rather than being ranked low. Factors and their weights
 * come from `scoring_weights`, and the weights actually used are snapshotted on
 * every row so a past ranking can be explained after the weights change.
 */
export async function POST(req: Request) {
  const s = createClient(); let actor: string | null;
  try { ({ actor } = await requireAdminOrSecret(req, s)); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: errStatus(e) }); }

  const marketId = new URL(req.url).searchParams.get("market") ?? "lexington-ky";
  const db = createAdminClient(); const t0 = Date.now();

  const [{ data: rows, error }, { data: weightRows }, { data: demandRows }, { data: capacityRule }] = await Promise.all([
    db.from("v_acquisition_candidates").select("*").eq("market_id", marketId),
    db.rpc("fn_scoring_weights", { p_market: marketId }),
    db.rpc("fn_sixgen_demand_points"),
    db.rpc("fn_rule_num", { p_jurisdiction: "lfucg", p_key: "max_guests_per_bedroom", p_zone: null, p_str_type: null }),
  ]);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!rows?.length) {
    return NextResponse.json({ ok: true, market: marketId, scored: 0, message: "No candidates yet — run a listings refresh first.", elapsedMs: Date.now() - t0 });
  }

  const weights: Weight[] = (weightRows ?? []).map((w: any) => ({ factorKey: w.factor_key, factorName: w.factor_name, weight: Number(w.weight) }));
  if (!weights.length) {
    return NextResponse.json({ error: "No scoring weights are configured for this market. Seed `scoring_weights` before ranking." }, { status: 409 });
  }
  const demand: DemandPoint[] = (demandRows ?? []).map((d: any) => ({ lat: d.lat, lng: d.lng, t12Revenue: Number(d.t12_revenue), name: d.name }));

  const result = scoreCandidates(rows.map(toCandidate), weights, {
    demand,
    guestsPerBedroom: capacityRule == null ? 2 : Number(capacityRule),
  });

  // one row per property, gated or not, so the Top 25 and the review lists both
  // read from the same computation
  const rulesVersion = rows.find((r: any) => r.rules_version)?.rules_version ?? null;
  const modelVersion = rows.find((r: any) => r.model_version)?.model_version ?? null;
  const now = new Date().toISOString();
  const payload = [...result.ranked, ...result.gated].map((sc) => ({
    property_id: sc.candidate.propertyId,
    listing_id: rows.find((r: any) => r.property_id === sc.candidate.propertyId)?.listing_id ?? null,
    score: sc.score ?? 0,
    rank: sc.rank,
    gated: sc.gated,
    gate_reason: sc.gateReason,
    unavailable_factors: sc.unavailableFactors,
    breakdown: sc.breakdown,
    weights_snapshot: result.weightsUsed,
    rules_version: rulesVersion,
    model_version: `${result.modelVersion}${modelVersion ? ` / ${modelVersion}` : ""}`,
    computed_at: now,
  }));

  for (let i = 0; i < payload.length; i += BATCH) {
    const { error: e } = await db.from("acquisition_scores").insert(payload.slice(i, i + BATCH));
    if (e) return NextResponse.json({ error: `writing scores: ${e.message}` }, { status: 500 });
  }

  const message = `${result.ranked.length} ranked · ${result.gated.length} gated · ${result.requiresReview.length} require review · ${result.needsHoaVerification.length} need HOA verification`;
  await audit(db, actor, "scores.run", "market", marketId, { ranked: result.ranked.length, gated: result.gated.length, ms: Date.now() - t0 });

  return NextResponse.json({
    ok: true, market: marketId,
    scored: result.ranked.length, gated: result.gated.length,
    requiresReview: result.requiresReview.length,
    needsHoaVerification: result.needsHoaVerification.length,
    weightsUsed: result.weightsUsed,
    unavailableFactors: [...new Set(result.ranked.flatMap((r) => r.unavailableFactors))],
    modelVersion: result.modelVersion, message,
    elapsedMs: Date.now() - t0,
  });
}

/** GET /api/scores?market=… — the ranked table plus the two side lists. */
export async function GET(req: Request) {
  const s = createClient();
  const { data: { user } } = await s.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const u = new URL(req.url);
  const marketId = u.searchParams.get("market") ?? "lexington-ky";
  const limit = Math.min(200, Math.max(1, Number(u.searchParams.get("limit") ?? 25) || 25));

  const [{ data: top, error }, { data: summary }, { data: weights }] = await Promise.all([
    s.from("v_top_candidates").select("*").eq("market_id", marketId).limit(limit),
    s.rpc("fn_acquisition_summary", { p_market: marketId }),
    s.rpc("fn_scoring_weights", { p_market: marketId }),
  ]);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  const [{ data: needsHoa }, { data: review }, { data: gated }] = await Promise.all([
    s.from("v_top_candidates").select("property_id,address,list_price,beds,score,hoa_status,forecast_revenue,gross_yield_pct")
      .eq("market_id", marketId).neq("hoa_status", "VERIFIED_NO_HOA").order("score", { ascending: false }).limit(25),
    s.from("v_top_candidates").select("property_id,address,list_price,beds,score,classification,eligibility_summary")
      .eq("market_id", marketId).eq("classification", "YELLOW").order("score", { ascending: false }).limit(25),
    s.from("v_latest_score").select("property_id,gate_reason").eq("gated", true).limit(50),
  ]);

  return NextResponse.json({
    top: top ?? [],
    needsHoaVerification: needsHoa ?? [],
    requiresReview: review ?? [],
    gatedCount: gated?.length ?? 0,
    summary: summary?.[0] ?? null,
    weights: weights ?? [],
  });
}
