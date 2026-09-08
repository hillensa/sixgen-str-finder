import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { safeRedirectPath } from "@/lib/safeRedirect";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");
  // `next` comes from the URL bar, so it is attacker-controlled. Pasting it
  // onto the origin by string concatenation is an open redirect — a value of
  // "@evil.com" produces a URL whose host is evil.com. Sanitize, then resolve
  // with the URL constructor so the origin can never be displaced.
  const next = safeRedirectPath(searchParams.get("next"));

  if (code) {
    const { error } = await createClient().auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(next, origin));
    return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(error.message)}`, origin));
  }
  return NextResponse.redirect(new URL("/login", origin));
}
