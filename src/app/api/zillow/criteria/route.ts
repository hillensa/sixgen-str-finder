import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient, requireAdminOrSecret, errStatus, audit } from "@/lib/supabase/admin";
import { ZILLOW_SETTINGS_KEY, parseCriteria, zillowSearchUrl } from "@/lib/zillow/criteria";
import { readCriteria } from "@/lib/zillow/settings";
export const dynamic = "force-dynamic";

/** GET /api/zillow/criteria — the saved search and the Zillow URL it produces. */
export async function GET() {
  const s = createClient();
  const { data: { user } } = await s.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const criteria = await readCriteria(s);
  return NextResponse.json({ criteria, url: zillowSearchUrl(criteria) });
}

/**
 * PUT /api/zillow/criteria  { bedsMin, bathsMin, hoaMax? }
 * Admin only. The weekly scheduled pull reads the same row, so this changes
 * next Monday's search as well as the next on-demand one.
 */
export async function PUT(req: Request) {
  const s = createClient(); let actor: string | null;
  try { ({ actor } = await requireAdminOrSecret(req, s)); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: errStatus(e) }); }
  const body = await req.json().catch(() => null);
  const parsed = parseCriteria(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const db = createAdminClient();
  const { error } = await db.from("app_settings")
    .upsert({ key: ZILLOW_SETTINGS_KEY, value: parsed.value, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  await audit(db, actor, "zillow.criteria", "app_settings", ZILLOW_SETTINGS_KEY, parsed.value);
  return NextResponse.json({ criteria: parsed.value, url: zillowSearchUrl(parsed.value) });
}
