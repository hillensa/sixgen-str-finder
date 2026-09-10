import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
export const dynamic = "force-dynamic";

/**
 * GET /api/streetview?lat=&lng= — a photo of the house, proxied.
 *
 * The ImagineMLS export carries no image field, so there is no listing photo to
 * show. Street View is the one picture of the actual house this app can obtain
 * without an MLS licence, and it answers the question being asked of it: what
 * does it look like from the road.
 *
 * Proxied rather than called from the browser so the key stays server-side and
 * is never in the bundle. Dark until `GOOGLE_STREETVIEW_KEY` is set: with no key
 * this 404s, the <img> fails, and the card falls back to its no-photo note. That
 * is deliberate — Street View is billed per request, so it must be opted into.
 */
export async function GET(req: Request) {
  const s = createClient();
  const { data: { user } } = await s.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const key = process.env.GOOGLE_STREETVIEW_KEY;
  if (!key) return NextResponse.json({ error: "Street View is not configured" }, { status: 404 });

  const u = new URL(req.url);
  const lat = Number(u.searchParams.get("lat")), lng = Number(u.searchParams.get("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json({ error: "lat and lng are required" }, { status: 400 });
  }

  const q = new URLSearchParams({
    size: "528x256", location: `${lat},${lng}`, fov: "70", source: "outdoor",
    return_error_code: "true", key,
  });
  // `return_error_code` makes Google 404 rather than bill for and return a grey
  // "no imagery" tile — a rural parcel would otherwise get a blank photo frame.
  let r: Response;
  try {
    r = await fetch(`https://maps.googleapis.com/maps/api/streetview?${q}`, { cache: "no-store" });
  } catch {
    return NextResponse.json({ error: "Street View is unreachable" }, { status: 502 });
  }
  if (!r.ok) return NextResponse.json({ error: "No Street View imagery here" }, { status: 404 });

  return new NextResponse(await r.arrayBuffer(), {
    headers: {
      "Content-Type": r.headers.get("content-type") ?? "image/jpeg",
      // The house does not move. Caching keeps a hovered row from re-billing.
      "Cache-Control": "private, max-age=86400",
    },
  });
}
