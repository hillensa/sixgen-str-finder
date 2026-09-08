/**
 * Rate limiting for the routes reachable without a session (Phase 7).
 *
 * Fixed-window counters in module memory. That is honest about what it is: on a
 * serverless host each instance keeps its own window, so the effective limit is
 * per-instance rather than global. It still does the job it is here for —
 * blunting credential-stuffing and scripted abuse of the magic-link endpoint and
 * the bearer-token import routes — and it costs no infrastructure.
 *
 * If this ever needs to be exact (a public API, billing, a hard quota), it must
 * move to a shared store. `limit()` returns everything a caller needs, so the
 * swap is contained.
 */
export type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the current window resets. */
  retryAfter: number;
};

type Window = { count: number; resetAt: number };
const windows = new Map<string, Window>();
let lastSweep = Date.now();

/** Drop expired windows so a long-lived instance does not grow unbounded. */
function sweep(now: number): void {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [k, w] of windows) if (w.resetAt <= now) windows.delete(k);
}

export function limit(key: string, max: number, windowMs: number, now = Date.now()): RateLimitResult {
  sweep(now);
  const existing = windows.get(key);
  if (!existing || existing.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, limit: max, remaining: max - 1, retryAfter: Math.ceil(windowMs / 1000) };
  }
  existing.count++;
  const retryAfter = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
  return {
    allowed: existing.count <= max,
    limit: max,
    remaining: Math.max(0, max - existing.count),
    retryAfter,
  };
}

/**
 * Caller identity for limiting. Behind Netlify or Vercel the client address is
 * the first entry of x-forwarded-for; the socket address is the proxy's.
 */
export function clientKey(req: Request): string {
  const h = req.headers;
  const fwd = h.get("x-nf-client-connection-ip")
    ?? h.get("x-real-ip")
    ?? h.get("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || "unknown";
}

/** The public surface, and what each is protected against. */
export const RULES: { pattern: RegExp; max: number; windowMs: number; reason: string }[] = [
  // magic-link requests: the one place an unauthenticated caller can make us send mail
  { pattern: /^\/login/, max: 10, windowMs: 60_000, reason: "sign-in requests" },
  { pattern: /^\/auth\/callback/, max: 20, windowMs: 60_000, reason: "auth callbacks" },
  // bearer-token machine routes: wrong secrets should not be cheap to guess
  { pattern: /^\/api\/(refresh|listings\/(refresh|import)|sixgen\/import|exclusions\/rebuild|eligibility\/rerun|scores|forecasts)/, max: 20, windowMs: 60_000, reason: "machine endpoints" },
  { pattern: /^\/api\/health/, max: 120, windowMs: 60_000, reason: "health checks" },
];

export function ruleFor(pathname: string) {
  return RULES.find((r) => r.pattern.test(pathname)) ?? null;
}
