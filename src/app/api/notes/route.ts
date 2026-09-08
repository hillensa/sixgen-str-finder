import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  const s = createClient(); const { data: { user } } = await s.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { property_id, body } = await req.json();
  if (!property_id || !body) return NextResponse.json({ error: "property_id and body required" }, { status: 400 });
  const { data, error } = await s.from("property_notes").insert({ property_id, user_id: user.id, body }).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ note: data });
}
