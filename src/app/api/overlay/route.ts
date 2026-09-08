import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  const u = new URL(req.url); const layer = u.searchParams.get("layer"); const bbox = u.searchParams.get("bbox"); const jid = u.searchParams.get("jurisdiction") ?? "lfucg";
  const s = createClient(); const { data: { user } } = await s.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: j } = await s.from("jurisdictions").select("*").eq("id", jid).single();
  if (!j) return NextResponse.json({ error: "Jurisdiction not found" }, { status: 404 });
  const urls: Record<string, string | null> = { parcels: j.gis_parcel_url, zoning: j.gis_zoning_url, boundary: j.gis_boundary_url };
  const url = urls[layer ?? ""]; if (!url) return NextResponse.json({ error: "Unknown layer" }, { status: 400 });
  const p = new URLSearchParams({ f: "geojson", where: "1=1", outFields: layer === "zoning" ? "ZONING,LINK" : layer === "boundary" ? "" : "ADDRESS", outSR: "4326", returnGeometry: "true", geometryPrecision: "6", resultRecordCount: "2000" });
  if (layer === "boundary") p.set("maxAllowableOffset", "0.0005");
  if (bbox) { p.set("geometry", bbox); p.set("geometryType", "esriGeometryEnvelope"); p.set("inSR", "4326"); p.set("spatialRel", "esriSpatialRelIntersects"); }
  try {
    const r = await fetch(`${url}/query`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: p, next: { revalidate: 600 } } as any);
    return NextResponse.json(await r.json(), { headers: { "cache-control": "private, max-age=300" } });
  } catch (e: any) { return NextResponse.json({ error: e.message }, { status: 502 }); }
}
