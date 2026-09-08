import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
export const dynamic = "force-dynamic";

/**
 * GET /api/pipeline?market=lexington-ky
 * The acquisition board: every property with a pipeline row, grouped by the
 * configured statuses, plus this user's saved properties.
 */
export async function GET(req: Request) {
  const s = createClient();
  const { data: { user } } = await s.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const marketId = new URL(req.url).searchParams.get("market") ?? "lexington-ky";

  const [{ data: statuses }, { data: rows, error }, { data: saved }] = await Promise.all([
    s.from("app_settings").select("value").eq("key", "pipeline_statuses").maybeSingle(),
    s.from("acquisition_pipeline").select("*").order("updated_at", { ascending: false }),
    s.from("saved_properties").select("property_id").eq("user_id", user.id),
  ]);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  const ids = [...new Set([...(rows ?? []).map((r: any) => r.property_id), ...(saved ?? []).map((r: any) => r.property_id)])];
  const { data: candidates } = ids.length
    ? await s.from("v_acquisition_candidates")
        .select("property_id,address,zip,list_price,beds,baths,sqft,classification,forecast_revenue,gross_yield_pct,url,hoa_status")
        .in("property_id", ids).eq("market_id", marketId)
    : { data: [] as any[] };
  const byId = new Map((candidates ?? []).map((c: any) => [c.property_id, c]));

  const { data: scores } = ids.length
    ? await s.from("v_latest_score").select("property_id,score,rank").in("property_id", ids)
    : { data: [] as any[] };
  const scoreById = new Map((scores ?? []).map((r: any) => [r.property_id, r]));

  const items = (rows ?? []).map((r: any) => ({
    ...r,
    property: byId.get(r.property_id) ?? null,
    score: scoreById.get(r.property_id)?.score ?? null,
  })).filter((r: any) => r.property);

  const savedIds = new Set((saved ?? []).map((r: any) => r.property_id));
  return NextResponse.json({
    statuses: statuses?.value ?? [],
    items,
    saved: (candidates ?? []).filter((c: any) => savedIds.has(c.property_id))
      .map((c: any) => ({ ...c, score: scoreById.get(c.property_id)?.score ?? null })),
  });
}
