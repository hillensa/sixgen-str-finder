import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient, requireAdmin, errStatus } from "@/lib/supabase/admin";
export const dynamic = "force-dynamic";

const PAGE = 100;

/**
 * GET /api/imports/:id?status=unmatched&page=0
 * The match report: the import header plus its rows, joined to the permit each
 * row produced so the operator can see and fix what happened.
 */
export async function GET(req: Request, { params }: { params: { id: string } }) {
  const s = createClient();
  try { await requireAdmin(s); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: errStatus(e) }); }
  const db = createAdminClient();

  const importId = Number(params.id);
  if (!Number.isFinite(importId)) return NextResponse.json({ error: "Bad import id" }, { status: 400 });

  const u = new URL(req.url);
  const status = u.searchParams.get("status");
  const page = Math.max(0, Number(u.searchParams.get("page") ?? 0) || 0);

  const { data: header, error: hErr } = await db.from("imports").select("*").eq("id", importId).single();
  if (hErr || !header) return NextResponse.json({ error: "Import not found" }, { status: 404 });

  let q = db.from("import_rows").select("*", { count: "exact" }).eq("import_id", importId);
  if (status && status !== "all") q = q.eq("status", status);
  const { data: rows, count } = await q.order("row_number").range(page * PAGE, page * PAGE + PAGE - 1);

  const permitIds = [...new Set((rows ?? []).map((r: any) => r.target_id).filter(Boolean))];
  const { data: permits } = permitIds.length
    ? await db.from("str_permits").select("id,address_norm,address_raw,unit,zip,str_type,permit_status,is_blocking,blocking_reason,lat,lng,parcel_id,match_status,match_confidence,match_method,geocode_method,address_confidence,review_note").in("id", permitIds)
    : { data: [] as any[] };
  const byId = new Map((permits ?? []).map((p: any) => [p.id, p]));

  const { data: tally } = await db.from("import_rows").select("status").eq("import_id", importId);
  const counts: Record<string, number> = {};
  for (const t of tally ?? []) counts[t.status ?? "unknown"] = (counts[t.status ?? "unknown"] ?? 0) + 1;

  return NextResponse.json({
    import: header,
    counts, total: count ?? 0, page, pageSize: PAGE,
    rows: (rows ?? []).map((r: any) => ({ ...r, permit: r.target_id ? byId.get(r.target_id) ?? null : null })),
  });
}
