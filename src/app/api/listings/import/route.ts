import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient, requireAdminOrSecret, errStatus, audit } from "@/lib/supabase/admin";
import { CsvProvider, JsonProvider } from "@/lib/providers/listings";
import { runRefresh } from "@/lib/listings/refresh";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST { market, format: 'csv'|'json', input, full?, fullSync?, rescreen? }
 *
 * Retained so existing callers and cron entries keep working. It delegates to
 * the same engine as /api/listings/refresh — there is one import path, not two
 * that can disagree.
 *
 * Note the changed default: `full` used to be ON unless explicitly disabled, so
 * a partial paste marked every other listing removed. A full sync must now be
 * asked for.
 */
export async function POST(req: Request) {
  const s = createClient(); let actor: string | null;
  try { ({ actor } = await requireAdminOrSecret(req, s)); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: errStatus(e) }); }

  const body = await req.json().catch(() => null);
  if (!body?.input) return NextResponse.json({ error: "input (CSV or JSON text) required" }, { status: 400 });

  const marketId = body.market ?? "lexington-ky";
  const provider = body.format === "json" ? new JsonProvider() : new CsvProvider();
  const db = createAdminClient();

  const result = await runRefresh(db, {
    marketId, provider, input: body.input,
    fullSync: body.fullSync === true || body.full === true,
    rescreen: body.rescreen !== false,
    useCensus: body.useCensus !== false,
    actor, note: body.fileName ?? null,
  });
  if ("error" in result) return NextResponse.json({ error: result.error }, { status: result.status });

  await audit(db, actor, "listings.import", "market", marketId, { received: result.received, counts: result.counts, fullSync: result.fullSync });

  // keep the older response shape for existing callers
  return NextResponse.json({
    ...result,
    // rows that actually landed, not the size of the diff that was attempted
    upserted: result.written,
    priceChanges: result.counts.price_change,
    removed: result.counts.removed,
  });
}
