import { createClient } from "@supabase/supabase-js";
/** Service-role client — BYPASSES RLS. Server-side only. */
export function createAdminClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, { auth: { autoRefreshToken: false, persistSession: false } });
}
export async function currentUser(supabase: any) {
  const { data: { user } } = await supabase.auth.getUser();
  return user ?? null;
}
export async function requireAdmin(supabase: any) {
  const user = await currentUser(supabase);
  if (!user) throw new Error("UNAUTHENTICATED");
  const { data } = await supabase.from("profiles").select("is_admin").eq("id", user.id).single();
  if (!data?.is_admin) throw new Error("FORBIDDEN");
  return user;
}
/** Accepts either an admin session or the shared IMPORT_SECRET bearer token. */
export async function requireAdminOrSecret(request: Request, supabase: any): Promise<{ actor: string | null }> {
  const secret = process.env.IMPORT_SECRET;
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (secret && bearer === secret) return { actor: null };
  const user = await requireAdmin(supabase);
  return { actor: user.id };
}
export function errStatus(e: any) {
  return e?.message === "FORBIDDEN" ? 403 : e?.message === "UNAUTHENTICATED" ? 401 : 500;
}
export async function audit(db: any, actor: string | null, action: string, entity?: string, entity_id?: string | number, detail?: any) {
  try { await db.from("audit_logs").insert({ actor, action, entity, entity_id: entity_id != null ? String(entity_id) : null, detail }); } catch { /* never block on audit */ }
}
