import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveParcel } from "@/lib/gis/parcel";
import { zoningTreatmentFor } from "@/lib/rules";
export const dynamic = "force-dynamic";

/** GET /api/gis/parcel-at?lat=..&lng=..&jurisdiction=lfucg */
export async function GET(req: Request) {
  const s = createClient();
  const { data: { user } } = await s.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const u = new URL(req.url);
  const lat = Number(u.searchParams.get("lat")), lng = Number(u.searchParams.get("lng"));
  const jid = u.searchParams.get("jurisdiction") ?? "lfucg";
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return NextResponse.json({ error: "lat/lng required" }, { status: 400 });

  const db = createAdminClient(); // writes to cache tables
  const { data: j } = await db.from("jurisdictions").select("*").eq("id", jid).single();
  if (!j) return NextResponse.json({ error: "Jurisdiction not found" }, { status: 404 });

  try {
    const result = await resolveParcel(db, j, lng, lat);
    const { data: rules } = await db.from("str_rules").select("*").eq("jurisdiction_id", jid);
    if (result.zoning) result.zoning.treatment = zoningTreatmentFor(rules ?? [], result.zoning.zone_code);
    return NextResponse.json(result);
  } catch (e: any) {
    await db.from("data_errors").insert({ category: "gis", entity: "parcel-at", message: e.message, detail: { lat, lng } });
    return NextResponse.json({ error: e.message }, { status: 502 });
  }
}
