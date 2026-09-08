import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient, requireAdminOrSecret, errStatus, audit } from "@/lib/supabase/admin";
import { classifyEligibility, factsFromRow } from "@/lib/eligibility";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const BATCH = 100;

/**
 * POST /api/eligibility/rerun?market=lexington-ky[&propertyIds=1,2,3]
 *
 * Re-screens properties against the current rules and records the outcome.
 * Every row stamps the `rules_version` it was decided under, so a later rules
 * change is visible as a stale version rather than a silent re-interpretation.
 *
 * Properties are linked to parcels first: separation is measured property line
 * to property line, and an unlinked property can only be screened from a point.
 */
export async function POST(req: Request) {
  const s = createClient(); let actor: string | null;
  try { ({ actor } = await requireAdminOrSecret(req, s)); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: errStatus(e) }); }

  const u = new URL(req.url);
  const marketId = u.searchParams.get("market") ?? "lexington-ky";
  const idsParam = u.searchParams.get("propertyIds");
  const db = createAdminClient(); const t0 = Date.now();

  const { data: market } = await db.from("markets").select("id").eq("id", marketId).maybeSingle();
  if (!market) return NextResponse.json({ error: `Market ${marketId} not found` }, { status: 404 });

  // 1. parcel links (cheap, and the spacing measurement depends on them)
  const { data: linked, error: linkErr } = await db.rpc("fn_link_properties_to_parcels", { p_market: marketId });
  if (linkErr) return NextResponse.json({ error: `parcel linking: ${linkErr.message}` }, { status: 500 });

  // 2. the target set
  let ids: number[];
  if (idsParam) {
    ids = idsParam.split(",").map((x) => Number(x.trim())).filter((n) => Number.isFinite(n));
    if (!ids.length) return NextResponse.json({ error: "propertyIds contained no usable ids" }, { status: 400 });
  } else {
    const { data: rows, error } = await db.from("properties").select("id").eq("market_id", marketId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    ids = (rows ?? []).map((r: any) => r.id);
  }
  if (!ids.length) {
    return NextResponse.json({ ok: true, market: marketId, linked: linked ?? 0, checked: 0, counts: {}, message: "No properties in this market yet — import listings first.", elapsedMs: Date.now() - t0 });
  }

  // 3. facts → classification → rows, in batches
  const counts: Record<string, number> = { GREEN: 0, YELLOW: 0, RED: 0 };
  let checked = 0, skipped = 0;

  for (let i = 0; i < ids.length; i += BATCH) {
    const slice = ids.slice(i, i + BATCH);
    const { data: facts, error } = await db.rpc("fn_eligibility_facts_for_properties", { p_property_ids: slice });
    if (error) return NextResponse.json({ error: `facts: ${error.message}`, checkedBefore: checked }, { status: 500 });

    const returned = new Set<number>();
    const checkRows = (facts ?? []).map((row: any) => {
      returned.add(row.property_id);
      const result = classifyEligibility(factsFromRow(row));
      return {
        property_id: row.property_id,
        rules_version: row.rules_version ?? "unversioned",
        classification: result.classification,
        summary: result.summary,
        cup_required: result.cupRequired,
        parcel_id: row.parcel_id ?? null,
        subject_source: row.subject_source ?? null,
        zone_code: row.zone_code ?? null,
        zone_ordinance_url: row.zone_ordinance_url ?? null,
        zoning_treatment: row.zoning_treatment ?? null,
        spacing_result: row.spacing_result ?? null,
        spacing_ft: row.spacing_ft ?? null,
        spacing_measured: row.spacing_measured ?? null,
        nearest_str_permit_id: row.nearest_permit_id ?? null,
        nearest_str_distance_ft: row.nearest_distance_ft ?? null,
        density_result: row.density_result ?? null,
        density_radius_ft: row.density_radius_ft ?? null,
        density_threshold_pct: row.density_threshold_pct ?? null,
        density_units: row.density_units ?? null,
        density_strs: row.density_strs ?? null,
        density_pct: row.density_pct ?? null,
        density_pct_after: row.density_pct_after ?? null,
        hoa_status: row.hoa_status ?? "HOA_UNKNOWN",
        parcel_match_confidence: row.parcel_match_confidence ?? null,
        details: { zoningSource: row.zoning_source ?? null, zoningNotes: row.zoning_notes ?? null, nearestAddress: row.nearest_address ?? null },
        _failures: result.failures,
      };
    });

    // a property with neither a parcel nor coordinates returns no facts row
    skipped += slice.filter((id) => !returned.has(id)).length;
    if (!checkRows.length) continue;

    const { data: inserted, error: insErr } = await db
      .from("eligibility_checks")
      .insert(checkRows.map(({ _failures, ...r }: any) => r))
      .select("id,property_id,classification");
    if (insErr) return NextResponse.json({ error: `writing checks: ${insErr.message}`, checkedBefore: checked }, { status: 500 });

    const checkIdByProperty = new Map((inserted ?? []).map((r: any) => [r.property_id, r.id]));
    const failureRows = checkRows.flatMap((r: any) => {
      const checkId = checkIdByProperty.get(r.property_id);
      if (!checkId) return [];
      return r._failures.map((f: any) => ({
        eligibility_check_id: checkId, code: f.code, severity: f.severity,
        message: f.message, evidence: f.evidence ?? null,
      }));
    });
    if (failureRows.length) {
      const { error: fErr } = await db.from("eligibility_failures").insert(failureRows);
      if (fErr) return NextResponse.json({ error: `writing reasons: ${fErr.message}`, checkedBefore: checked }, { status: 500 });
    }

    for (const r of inserted ?? []) counts[r.classification] = (counts[r.classification] ?? 0) + 1;
    checked += inserted?.length ?? 0;
  }

  const message = `${counts.GREEN ?? 0} green · ${counts.YELLOW ?? 0} yellow · ${counts.RED ?? 0} red${skipped ? ` · ${skipped} skipped (no parcel or coordinates)` : ""}`;
  await audit(db, actor, "eligibility.rerun", "market", marketId, { checked, skipped, linked, counts, ms: Date.now() - t0 });

  return NextResponse.json({
    ok: true, market: marketId, linked: linked ?? 0, checked, skipped, counts, message,
    elapsedMs: Date.now() - t0,
  });
}

/** GET /api/eligibility/rerun?market=… — current classification counts. */
export async function GET(req: Request) {
  const s = createClient();
  const { data: { user } } = await s.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const marketId = new URL(req.url).searchParams.get("market") ?? "lexington-ky";
  const { data, error } = await s.rpc("fn_eligibility_summary", { p_market: marketId });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const counts: Record<string, number> = {};
  for (const r of data ?? []) counts[r.classification] = r.n;
  return NextResponse.json({ market: marketId, counts });
}
