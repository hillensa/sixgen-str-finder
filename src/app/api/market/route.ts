import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { mapPermits, permitCounts } from "@/lib/permits";
export const dynamic = "force-dynamic";
const PERMIT_COLS = "id,address_norm,address_raw,unit,str_type,permit_status,is_blocking,blocking_reason,lat,lng,source,match_status,match_confidence,geocode_method,review_note";

async function allPermits(s: any): Promise<{ data: any[]; error: any }> {
  const PAGE = 1000; const out: any[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await s.from("str_permits").select(PERMIT_COLS)
      .order("id", { ascending: true }).range(from, from + PAGE - 1);
    if (error) return { data: out, error };
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return { data: out, error: null };
  }
}

export async function GET(req: Request) {
  const mid = new URL(req.url).searchParams.get("market") ?? "lexington-ky";
  const s = createClient(); const { data: { user } } = await s.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const [market, jur, permits, excl, me] = await Promise.all([
    s.from("markets").select("*").eq("id", mid).single(),
    s.from("jurisdictions").select("*").eq("market_id", mid).limit(1).maybeSingle(),
    // INVARIANT: every permit, every type — no predicate. Unlocated ones are flagged, not hidden (see lib/permits.ts).
    // Paged: a single select is cut off at PostgREST's max-rows (1000), which
    // silently broke this invariant as soon as the table passed a thousand rows.
    allPermits(s),
    s.from("v_market_exclusions_geojson").select("*").limit(1).maybeSingle(),
    s.from("profiles").select("is_admin,email").eq("id", user.id).single(),
  ]);
  if (market.error) return NextResponse.json({ error: `Market not found: ${mid}` }, { status: 404 });
  return NextResponse.json({ market: market.data, jurisdiction: jur.data, permits: mapPermits((permits.data ?? []) as any), permitCounts: permitCounts(mapPermits((permits.data ?? []) as any)), exclusion: excl.data?.geojson ?? null, exclusionMeta: excl.data ? { parcelCount: excl.data.parcel_count, permitCount: excl.data.permit_count, areaSqMi: excl.data.area_sq_mi, computedAt: excl.data.computed_at, rulesVersion: excl.data.rules_version } : null, me: { email: me.data?.email ?? user.email, isAdmin: !!me.data?.is_admin } });
}
