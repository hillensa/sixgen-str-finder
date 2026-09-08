import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient, requireAdmin, errStatus, audit } from "@/lib/supabase/admin";
import { normalizeAddress, parseAddress } from "@/lib/address";
import { geocodeOne } from "@/lib/geocode";
import { parseStrType, parsePermitStatus } from "@/lib/import/columns";
export const dynamic = "force-dynamic";

/**
 * GET  /api/permits/:id                → the permit plus nearby parcel candidates
 * PATCH /api/permits/:id               → operator fix (address, coordinates, parcel,
 *                                        type, status). Marks the row match_method
 *                                        'manual' so the next city sync leaves it alone.
 */
export async function GET(req: Request, { params }: { params: { id: string } }) {
  const s = createClient();
  try { await requireAdmin(s); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: errStatus(e) }); }
  const db = createAdminClient();

  const { data: permit } = await db.from("str_permits").select("*").eq("id", Number(params.id)).single();
  if (!permit) return NextResponse.json({ error: "Permit not found" }, { status: 404 });

  let candidates: any[] = [];
  if (permit.lat != null && permit.lng != null) {
    const { data } = await db.rpc("fn_parcel_candidates", {
      p_jurisdiction: permit.jurisdiction_id, p_lng: permit.lng, p_lat: permit.lat, p_radius_ft: 300,
    });
    candidates = data ?? [];
  }
  return NextResponse.json({ permit, candidates });
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const s = createClient(); let user;
  try { user = await requireAdmin(s); } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: errStatus(e) }); }
  const db = createAdminClient();
  const id = Number(params.id);

  const { data: permit } = await db.from("str_permits").select("*, jurisdictions(*)").eq("id", id).single();
  if (!permit) return NextResponse.json({ error: "Permit not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const patch: Record<string, any> = { updated_at: new Date().toISOString(), match_method: "manual" };
  const changed: string[] = [];

  if (typeof body.address === "string" && body.address.trim()) {
    const p = parseAddress(body.address);
    if (!p.normalized) return NextResponse.json({ error: "That address could not be parsed." }, { status: 400 });
    patch.address_raw = body.address.trim();
    patch.address_norm = p.normalized;
    patch.unit = p.unit ?? permit.unit;
    patch.zip = p.zip ?? permit.zip;
    changed.push("address");
  }
  if (body.str_type !== undefined) {
    patch.str_type = body.str_type === null ? null : parseStrType(body.str_type);
    changed.push("str_type");
  }
  if (body.permit_status !== undefined) {
    patch.permit_status = parsePermitStatus(body.permit_status);
    changed.push("permit_status");
  }
  if (body.review_note !== undefined) { patch.review_note = body.review_note || null; changed.push("review_note"); }

  // explicit coordinates win over a re-geocode
  if (body.lat != null && body.lng != null) {
    const lat = Number(body.lat), lng = Number(body.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)
      return NextResponse.json({ error: "lat/lng are out of range." }, { status: 400 });
    patch.lat = lat; patch.lng = lng;
    patch.address_confidence = 1; patch.geocode_method = "manual"; patch.match_confidence = 1;
    changed.push("coordinates");
  } else if (body.regeocode) {
    const addr = patch.address_raw ?? permit.address_raw ?? permit.address_norm;
    const g = await geocodeOne(db, (permit as any).jurisdictions, addr, patch.zip ?? permit.zip);
    if (!g) return NextResponse.json({ error: "Geocoder found no match for that address. Enter coordinates manually." }, { status: 422 });
    patch.lat = g.lat; patch.lng = g.lng;
    patch.address_confidence = g.confidence; patch.geocode_method = g.method; patch.match_confidence = g.confidence;
    changed.push("coordinates");
  }

  if (body.parcel_id !== undefined) {
    if (body.parcel_id === null) { patch.parcel_id = null; patch.match_status = "possible"; }
    else {
      const { data: pc } = await db.from("parcels").select("id,jurisdiction_id").eq("id", Number(body.parcel_id)).single();
      if (!pc || pc.jurisdiction_id !== permit.jurisdiction_id)
        return NextResponse.json({ error: "That parcel does not exist in this jurisdiction." }, { status: 400 });
      patch.parcel_id = pc.id; patch.match_status = "matched"; patch.match_confidence = 1;
    }
    changed.push("parcel");
  }
  if (body.match_status && ["matched", "possible", "unmatched", "duplicate", "invalid"].includes(body.match_status)) {
    patch.match_status = body.match_status; changed.push("match_status");
  }
  if (!changed.length) return NextResponse.json({ error: "Nothing to change." }, { status: 400 });

  const { data: updated, error } = await db.from("str_permits").update(patch).eq("id", id).select("*").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  // re-derive the blocking flag (type or status may have changed) and tell the
  // caller whether the exclusion zone is now stale
  const { data: blk } = await db.rpc("fn_apply_blocking_rules", { p_jurisdiction: permit.jurisdiction_id });
  await audit(db, user.id, "permit.manual_fix", "str_permits", id, { changed, patch });

  return NextResponse.json({
    ok: true, permit: updated, changed, blocking: blk?.[0] ?? null,
    exclusionStale: changed.some((c) => ["coordinates", "parcel", "str_type", "permit_status", "address"].includes(c)),
  });
}
