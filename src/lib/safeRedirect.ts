/**
 * Post-login redirect target sanitizer.
 *
 * The `next` parameter reaches /auth/callback from the URL bar, so it is
 * attacker-controlled. Concatenating it onto the origin is not safe:
 *
 *   "@evil.com"      -> https://site.com@evil.com   host is evil.com; site.com
 *                                                   is parsed as userinfo
 *   "//evil.com"     -> protocol-relative, resolves off-site
 *   "https://evil"   -> absolute off-site URL
 *   "\evil.com"      -> backslashes normalize to slashes in browsers
 *
 * Only a single-slash, same-origin path is allowed through; anything else falls
 * back to the dashboard. Pure function — unit-tested in tests/redirect.test.ts.
 */
export const DEFAULT_REDIRECT = "/dashboard";

/** C0 controls plus DEL — a tab or newline here can split a header. */
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

export function safeRedirectPath(next: string | null | undefined, fallback = DEFAULT_REDIRECT): string {
  if (!next) return fallback;

  const trimmed = next.trim();
  if (!trimmed) return fallback;
  if (CONTROL_CHARS.test(trimmed)) return fallback;

  // browsers treat "\" as "/" when resolving a URL, so normalize before checking
  const candidate = trimmed.replace(/\\/g, "/");

  if (!candidate.startsWith("/")) return fallback;              // absolute URL, scheme, or "@host"
  if (candidate.startsWith("//")) return fallback;              // protocol-relative
  if (/^\/+[a-z][a-z0-9+.-]*:/i.test(candidate)) return fallback; // "/javascript:…"

  return candidate;
}
