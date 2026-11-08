import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient, requireAdminOrSecret, errStatus, audit } from "@/lib/supabase/admin";
import { ZillowProvider } from "@/lib/providers/listings";
import { runRefresh } from "@/lib/listings/refresh";
import { filterSignature } from "@/lib/zillow/criteria";
import { readCriteria } from "@/lib/zillow/settings";
import { parsePayload, applyCriteria, isComplete, matchesCriteria, toImportCsv } from "@/lib/zillow/payload";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/zillow/import  { payload }
 *
 * Takes what the "Send to Sixgen" bookmark collected on Zillow and runs it
 * through the same refresh path every other listing source uses. The rules that
 * keep a pull honest are enforced here rather than trusted from the browser:
 *
 *  - the Zillow page must have used the filters Sixgen has saved, or the import
 *    is refused (the homes would be from a different search);
 *  - every row is re-checked against the bed and bath minimums;
 *  - full sync — which retires Zillow listings missing from the set — runs only
 *    when every page was collected and the homes add up to Zillow's total. A
 *    partial pull adds and updates, and retires nothing.
 *
 * The caller re-forecasts and re-ranks afterwards (/api/forecasts, /api/scores).
 */
export async function POST(req: Request) {
  const s = createClient(); let actor: string | null;
  try { ({ actor } = await requireAdminOrSecret(req, s)); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: errStatus(e) }); }

  const body = await req.json().catch(() => null);
  const text = typeof body?.payload === "string" ? body.payload : JSON.stringify(body?.payload ?? null);
  const parsed = parsePayload(text);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const p = parsed.value;

  const db = createAdminClient();
  const criteria = await readCriteria(db);
  if (!matchesCriteria(p, criteria)) {
    return NextResponse.json({
      error: `These homes came from a Zillow search with different filters (${p.signature ?? "unknown"}) than Sixgen is set to (${filterSignature(criteria)}). `
        + "Open the search from the Zillow page in Sixgen so the two match, then collect it again.",
    }, { status: 409 });
  }

  const { kept, rejected } = applyCriteria(p.homes, criteria);
  if (!kept.length) return NextResponse.json({ error: "None of the pasted homes meet the saved bed and bath minimums." }, { status: 400 });
  const complete = isComplete(p);

  const result = await runRefresh(db, {
    marketId: "lexington-ky", provider: new ZillowProvider(), input: toImportCsv(kept),
    fullSync: complete, rescreen: true, useCensus: true, actor,
    note: `Zillow pull on demand: ${filterSignature(criteria)} · ${p.homes.length} of ${p.total ?? "?"} homes, `
      + `pages ${p.pages.join(",") || "?"} of ${p.totalPages ?? "?"}${complete ? "" : " (PARTIAL — nothing retired)"}`,
  });
  if ("error" in result) return NextResponse.json({ error: result.error }, { status: result.status });

  await audit(db, actor, "zillow.import", "market", "lexington-ky", {
    criteria, received: p.homes.length, kept: kept.length, rejected: rejected.length, dropped: parsed.dropped,
    complete, counts: result.counts,
  });

  return NextResponse.json({
    ok: true, complete, fullSync: complete,
    received: p.homes.length, kept: kept.length, rejectedByCriteria: rejected.length, droppedMalformed: parsed.dropped,
    zillowTotal: p.total, pages: p.pages, totalPages: p.totalPages,
    counts: result.counts, message: result.message, coordinates: result.coordinates,
  });
}
