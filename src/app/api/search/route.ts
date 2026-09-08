import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { searchAddresses } from "@/lib/arcgis";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  const u = new URL(req.url); const q = (u.searchParams.get("q") ?? "").trim(); const jid = u.searchParams.get("jurisdiction") ?? "lfucg";
  if (q.length < 3) return NextResponse.json({ results: [] });
  const s = createClient(); const { data: { user } } = await s.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: j } = await s.from("jurisdictions").select("gis_address_url").eq("id", jid).single();
  if (!j?.gis_address_url) return NextResponse.json({ results: [] });
  try { return NextResponse.json({ results: await searchAddresses(j.gis_address_url, q) }); }
  catch (e: any) { return NextResponse.json({ results: [], error: e.message }, { status: 502 }); }
}
