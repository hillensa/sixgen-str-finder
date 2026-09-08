import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient, requireAdminOrSecret, errStatus, audit } from "@/lib/supabase/admin";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST /api/exclusions/rebuild?jurisdiction=lfucg
 *
 * Re-derive is_blocking from the current str_rules, then dissolve the spacing
 * buffers into `market_exclusions`. Called after a manual permit fix, after a
 * rules change, and at the end of every import.
 *
 * Refuses to write an empty exclusion: on a legal screen, "nothing blocks
 * anything" is far more likely to be a misconfiguration than the truth.
 */
export async function POST(req: Request) {
  const s = createClient(); let actor: string | null;
  try { ({ actor } = await requireAdminOrSecret(req, s)); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: errStatus(e) }); }

  const jid = new URL(req.url).searchParams.get("jurisdiction") ?? "lfucg";
  const force = new URL(req.url).searchParams.get("force") === "true";
  const db = createAdminClient();

  const { data: blk, error: blkErr } = await db.rpc("fn_apply_blocking_rules", { p_jurisdiction: jid });
  if (blkErr) return NextResponse.json({ error: blkErr.message }, { status: 500 });
  const blocking = blk?.[0]?.blocking ?? 0;

  const { count: permitCount } = await db.from("str_permits").select("id", { count: "exact", head: true }).eq("jurisdiction_id", jid);
  if (!blocking && (permitCount ?? 0) > 0 && !force) {
    return NextResponse.json({
      error: `${permitCount} permits are loaded but none qualify as blocking under the current rules. Check Admin → STR Rules (spacing_ft and blocking_permit_statuses) before rebuilding, or re-send with ?force=true to publish an empty exclusion deliberately.`,
      blocking: blk?.[0] ?? null,
    }, { status: 409 });
  }

  const { data: ex, error } = await db.rpc("fn_rebuild_exclusions", { p_jurisdiction: jid });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { data: report } = await db.rpc("fn_permit_match_report", { p_jurisdiction: jid });
  await audit(db, actor, "exclusions.rebuild", "jurisdiction", jid, { blocking: blk?.[0] ?? null, exclusion: ex?.[0] ?? null });
  return NextResponse.json({ ok: true, blocking: blk?.[0] ?? null, exclusion: ex?.[0] ?? null, report: report ?? [] });
}
