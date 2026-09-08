import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient, requireAdminOrSecret, errStatus, audit } from "@/lib/supabase/admin";
import { getProvider, CsvProvider, JsonProvider } from "@/lib/providers/listings";
import { runRefresh } from "@/lib/listings/refresh";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/listings/refresh
 * body: { market?, format?: 'csv'|'json', input?, fullSync?, rescreen?, note? }
 *
 * The 🔄 Refresh Lexington Listings action. Diffs the provider's set against
 * what is stored, records new / price change / relisted / removed with a reason
 * for each, appends price history, and re-screens only the properties that
 * newly entered the pool.
 *
 * `fullSync` defaults to FALSE. Phase 1 defaulted it on, so pasting a five-row
 * correction marked every other listing in the market as removed.
 */
export async function POST(req: Request) {
  const s = createClient(); let actor: string | null;
  try { ({ actor } = await requireAdminOrSecret(req, s)); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: errStatus(e) }); }

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });

  const marketId = body.market ?? "lexington-ky";
  const provider = body.format === "json" ? new JsonProvider()
    : body.format === "csv" ? new CsvProvider()
    : getProvider();

  // A pasted payload is required for the csv/json providers; a future feed
  // provider fetches its own set and needs none.
  if ((provider.id === "csv" || provider.id === "json") && !body.input) {
    return NextResponse.json({ error: "input (CSV or JSON text) is required for this provider." }, { status: 400 });
  }

  const db = createAdminClient();
  const result = await runRefresh(db, {
    marketId, provider, input: body.input,
    fullSync: body.fullSync === true,
    rescreen: body.rescreen !== false,
    useCensus: body.useCensus !== false,
    actor, note: body.note ?? null,
  });

  if ("error" in result) return NextResponse.json({ error: result.error }, { status: result.status });

  await audit(db, actor, "listings.refresh", "market", marketId, {
    received: result.received, counts: result.counts, fullSync: result.fullSync,
    rescreened: result.rescreened, ms: result.elapsedMs,
  });
  return NextResponse.json(result);
}

/** GET /api/listings/refresh?market=… — the refresh history. */
export async function GET(req: Request) {
  const s = createClient();
  const { data: { user } } = await s.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const marketId = new URL(req.url).searchParams.get("market") ?? "lexington-ky";
  const { data, error } = await s.from("listing_refreshes")
    .select("*").eq("market_id", marketId).order("started_at", { ascending: false }).limit(20);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ refreshes: data ?? [] });
}
