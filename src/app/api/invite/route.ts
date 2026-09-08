import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient, requireAdmin, errStatus, audit } from "@/lib/supabase/admin";
export const dynamic = "force-dynamic";
export async function GET() {
  const s = createClient(); try { await requireAdmin(s); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: errStatus(e) }); }
  const db = createAdminClient();
  const [{ data: allowed }, { data: profiles }] = await Promise.all([db.from("allowed_emails").select("*").order("created_at", { ascending: false }), db.from("profiles").select("id,email,is_admin,created_at")]);
  return NextResponse.json({ allowed: allowed ?? [], profiles: profiles ?? [] });
}
export async function POST(req: Request) {
  const s = createClient(); let user; try { user = await requireAdmin(s); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: errStatus(e) }); }
  const { email, note, sendEmail } = await req.json(); const clean = String(email ?? "").trim().toLowerCase();
  if (!clean.includes("@")) return NextResponse.json({ error: "Valid email required" }, { status: 400 });
  const db = createAdminClient();
  const { error } = await db.from("allowed_emails").upsert({ email: clean, invited_by: user.id, note: note ?? null }, { onConflict: "email" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  let emailed = false;
  if (sendEmail !== false) { const { error: ie } = await db.auth.admin.inviteUserByEmail(clean, { redirectTo: `${process.env.NEXT_PUBLIC_SITE_URL ?? ""}/auth/callback` }); emailed = !ie; }
  await audit(db, user.id, "user.invite", "allowed_emails", clean);
  return NextResponse.json({ ok: true, email: clean, emailed });
}
export async function DELETE(req: Request) {
  const s = createClient(); let user; try { user = await requireAdmin(s); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: errStatus(e) }); }
  const email = new URL(req.url).searchParams.get("email")?.toLowerCase(); if (!email) return NextResponse.json({ error: "email required" }, { status: 400 });
  const db = createAdminClient(); await db.from("allowed_emails").delete().eq("email", email);
  const { data: p } = await db.from("profiles").select("id").eq("email", email).maybeSingle(); if (p?.id) await db.auth.admin.deleteUser(p.id);
  await audit(db, user.id, "user.revoke", "allowed_emails", email);
  return NextResponse.json({ ok: true });
}
