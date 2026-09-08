import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { parseListingFilters, applyListingFilters, describeFilters } from "@/lib/listings/query";
export const dynamic = "force-dynamic";

/**
 * GET /api/listings?minPrice=…&minBeds=…&classification=GREEN,YELLOW&sort=price_drop
 *
 * The All Listings feed. Filtering, sorting and paging happen in Postgres over
 * v_listings_enriched; the optional filter set is parsed and validated in
 * lib/listings/query.ts so a malformed query string cannot reach the database.
 */
export async function GET(req: Request) {
  const s = createClient();
  const { data: { user } } = await s.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const f = parseListingFilters(new URL(req.url).searchParams);
  const query = applyListingFilters(s.from("v_listings_enriched").select("*", { count: "exact" }) as any, f);
  const { data, count, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  const { data: summary } = await s.rpc("fn_listing_summary", { p_market: f.market });

  return NextResponse.json({
    listings: data ?? [],
    total: count ?? 0,
    page: f.page,
    pageSize: f.pageSize,
    filters: f,
    activeFilters: describeFilters(f),
    summary: summary?.[0] ?? null,
  });
}
