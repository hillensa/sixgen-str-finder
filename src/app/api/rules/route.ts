import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient, requireAdmin, errStatus, audit } from "@/lib/supabase/admin";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  // Check the session before querying. Without this the RLS refusal surfaced as
  // a 400 with a Postgres message, so an unauthenticated caller got a different
  // shape of answer here than from every other read endpoint.
  const s = createClient();
  const { data: { user } } = await s.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const j = new URL(req.url).searchParams.get("jurisdiction") ?? "lfucg";
  const { data, error } = await s.from("str_rules").select("*").eq("jurisdiction_id", j).order("rule_key").order("effective_date", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ rules: data });
}

/** Create or update a rule (admin). Body: partial StrRule with optional id. */
export async function POST(req: Request) {
  const s = createClient();
  let user; try { user = await requireAdmin(s); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: errStatus(e) }); }
  const body = await req.json();
  const db = createAdminClient();
  const row: any = {
    jurisdiction_id: body.jurisdiction_id ?? "lfucg", rule_key: body.rule_key, rule_name: body.rule_name,
    value_num: body.value_num === "" || body.value_num == null ? null : Number(body.value_num),
    value_text: body.value_text || null, value_json: body.value_json ?? null,
    applicable_zoning: Array.isArray(body.applicable_zoning) ? body.applicable_zoning : typeof body.applicable_zoning === "string" && body.applicable_zoning.trim() ? body.applicable_zoning.split(",").map((z: string) => z.trim().toUpperCase()).filter(Boolean) : null,
    applicable_str_type: body.applicable_str_type || null,
    effective_date: body.effective_date || new Date().toISOString().slice(0, 10), end_date: body.end_date || null,
    enabled: !!body.enabled, source: body.source || null, notes: body.notes || null,
    rules_version: body.rules_version || `v${new Date().toISOString().slice(0, 7).replace("-", ".")}`,
    updated_at: new Date().toISOString(),
  };
  if (!row.rule_key || !row.rule_name) return NextResponse.json({ error: "rule_key and rule_name required" }, { status: 400 });
  const q = body.id ? db.from("str_rules").update(row).eq("id", body.id) : db.from("str_rules").insert({ ...row, created_by: user.id });
  const { data, error } = await q.select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  await audit(db, user.id, body.id ? "rule.update" : "rule.create", "str_rules", data.id, row);
  return NextResponse.json({ rule: data });
}

export async function DELETE(req: Request) {
  const s = createClient();
  let user; try { user = await requireAdmin(s); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: errStatus(e) }); }
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const db = createAdminClient();
  const { error } = await db.from("str_rules").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  await audit(db, user.id, "rule.delete", "str_rules", id);
  return NextResponse.json({ ok: true });
}
