import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { limit, clientKey, ruleFor } from "@/lib/rateLimit";
import { safeRedirectPath } from "@/lib/safeRedirect";
import { logWarn } from "@/lib/log";

const PUBLIC = ["/login", "/auth/callback", "/api/health"];
const MACHINE = ["/api/listings/import", "/api/listings/refresh", "/api/refresh",
                 "/api/exclusions/rebuild", "/api/eligibility/rerun", "/api/scores", "/api/forecasts",
                 "/api/sixgen/import"];

/**
 * Sent on every response. `frame-ancestors 'none'` is the one that matters most
 * here: this app renders legal screening results, and letting a third party
 * frame it invites clickjacking a pipeline action.
 */
const SECURITY_HEADERS: [string, string][] = [
  ["x-content-type-options", "nosniff"],
  ["x-frame-options", "DENY"],
  ["referrer-policy", "strict-origin-when-cross-origin"],
  ["permissions-policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()"],
  ["content-security-policy", "frame-ancestors 'none'"],
];
const applyHeaders = (res: NextResponse) => {
  for (const [k, v] of SECURITY_HEADERS) res.headers.set(k, v);
  return res;
};

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // ── rate limit before doing any work ─────────────────────────────────────
  const rule = ruleFor(pathname);
  if (rule) {
    const r = limit(`${rule.pattern.source}:${clientKey(request)}`, rule.max, rule.windowMs);
    if (!r.allowed) {
      logWarn("ratelimit.blocked", { path: pathname, reason: rule.reason, limit: r.limit, retryAfter: r.retryAfter });
      return applyHeaders(NextResponse.json(
        { error: `Too many ${rule.reason}. Try again in ${r.retryAfter}s.` },
        { status: 429, headers: { "retry-after": String(r.retryAfter), "x-ratelimit-limit": String(r.limit), "x-ratelimit-remaining": "0" } },
      ));
    }
  }

  let response = NextResponse.next({ request });
  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (all: { name: string; value: string; options?: any }[]) => {
        all.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        all.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  let user = null;
  try {
    ({ data: { user } } = await supabase.auth.getUser());
  } catch (e) {
    // Supabase unreachable: fail closed rather than letting everyone through
    logWarn("auth.unavailable", { path: pathname, error: (e as Error).message });
  }

  const isPublic = PUBLIC.some((p) => pathname.startsWith(p));
  const isMachine = MACHINE.some((p) => pathname.startsWith(p)) && request.headers.has("authorization");

  if (!user && !isPublic && !isMachine) {
    // An API caller wants an answer, not a login page. Redirecting here would
    // hand `fetch()` a 200 of HTML after it followed the 307, and every client
    // error path in the app would break trying to parse it.
    if (pathname.startsWith("/api/")) {
      return applyHeaders(NextResponse.json({ error: "Unauthorized" }, { status: 401 }));
    }
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    // `next` is echoed back by /auth/callback, so it is sanitized on the way in
    url.searchParams.set("next", safeRedirectPath(pathname));
    return applyHeaders(NextResponse.redirect(url));
  }
  return applyHeaders(response);
}

export const config = {
  // robots.txt and sitemap.xml are excluded deliberately. robots.txt was being
  // redirected to /login like any other path, so a crawler never reached the
  // Disallow and the login page could still surface in search beside the public
  // sixgenrentals.com site — the exact thing the file exists to prevent. Neither
  // carries anything worth gating.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\.(?:svg|png|jpg|jpeg|gif|webp|js)$).*)"],
};
