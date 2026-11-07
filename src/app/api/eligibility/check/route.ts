import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveParcel } from "@/lib/gis/parcel";
import { classifyEligibility, factsFromRow } from "@/lib/eligibility";
import { nearestPermits } from "@/lib/gis/distance";
import type { HoaStatus } from "@/lib/types";
export const dynamic = "force-dynamic";

const HOA_VALUES: HoaStatus[] = ["VERIFIED_NO_HOA", "HOA_PRESENT", "HOA_UNKNOWN"];

/**
 * GET /api/eligibility/check?lat=..&lng=..&hoa=HOA_UNKNOWN&jurisdiction=lfucg
 *
 * Ad-hoc screening for a point that may not be a listing — the Test Address
 * page. Resolves (and caches) the parcel, runs the PostGIS facts against the
 * parcel polygon so separation is measured property line to property line, then
 * classifies. Writes no eligibility_checks row: those belong to properties.
 */
export async function GET(req: Request) {
  const s = createClient();
  const { data: { user } } = await s.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const u = new URL(req.url);
  const lat = Number(u.searchParams.get("lat")), lng = Number(u.searchParams.get("lng"));
  const jid = u.searchParams.get("jurisdiction") ?? "lfucg";
  const hoaParam = u.searchParams.get("hoa") as HoaStatus | null;
  const hoaStatus: HoaStatus = hoaParam && HOA_VALUES.includes(hoaParam) ? hoaParam : "HOA_UNKNOWN";
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return NextResponse.json({ error: "lat/lng required" }, { status: 400 });

  const db = createAdminClient();          // writes to the parcel/zoning cache
  const { data: j } = await db.from("jurisdictions").select("*").eq("id", jid).single();
  if (!j) return NextResponse.json({ error: "Jurisdiction not found" }, { status: 404 });

  try {
    const parcel = await resolveParcel(db, j, lng, lat);

    // Measure from the parcel polygon when we have one — the 600 ft is property
    // line to property line — and fall back to the bare point when we do not,
    // recording which was used so the classifier can downgrade accordingly.
    const parcelId = parcel.found ? parcel.parcel?.id ?? null : null;
    const subjectSource: "parcel" | "point" = parcelId ? "parcel" : "point";

    const { data: facts, error } = parcelId
      ? await db.rpc("fn_eligibility_facts_for_parcel", { p_jurisdiction: jid, p_parcel_id: parcelId })
      : await db.rpc("fn_eligibility_facts_at_point", { p_jurisdiction: jid, p_lng: lng, p_lat: lat });
    if (error) return NextResponse.json({ error: `eligibility: ${error.message}` }, { status: 500 });

    const row = facts?.[0] ?? {};
    const eligibility = classifyEligibility(factsFromRow(row, {
      hoaStatus,
      subjectSource,
      parcelMatchConfidence: subjectSource === "parcel" ? 0.95 : null,
    }));

    // How close the existing STRs actually are.
    //
    // The spacing test above stops looking at the rule distance, so a passing
    // address reports no nearest-STR distance at all — the screening answers
    // "is it legal", never "how close is the competition". This answers the
    // second question, straight-line and clearly labelled as such, so it is
    // never mistaken for the property-line measurement the rule uses.
    const { data: permitRows } = await db
      .from("str_permits")
      .select("id,address_norm,address_raw,str_type,is_blocking,lat,lng")
      .eq("jurisdiction_id", jid);
    const { nearest, unlocated } = nearestPermits({ lat, lng }, permitRows ?? [], 8);

    return NextResponse.json({
      parcel, facts: row, eligibility,
      nearby: {
        measured: "straight_line_from_geocoded_point",
        permits: nearest.map((p) => ({
          id: p.id,
          address: p.address_norm ?? p.address_raw,
          str_type: p.str_type,
          is_blocking: p.is_blocking,
          distance_ft: p.distance_ft,
          lat: p.lat, lng: p.lng,
        })),
        unlocated,
      },
      rulesVersion: row.rules_version ?? null,
      checkedAt: new Date().toISOString(),
    });
  } catch (e: any) {
    await db.from("data_errors").insert({ category: "gis", entity: "eligibility-check", message: e.message, detail: { lat, lng } });
    return NextResponse.json({ error: e.message }, { status: 502 });
  }
}
