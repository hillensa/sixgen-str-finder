/**
 * Structured logging (Phase 7).
 *
 * One JSON object per line on stdout, which is what Netlify, Vercel and every
 * log aggregator expect. No dependency, and no logger instance to thread through
 * call sites.
 *
 * The one rule that matters: **never log a secret or a whole request body.**
 * This app handles a service-role key and an import secret, and a log line is
 * the easiest place for either to escape. `redact` below is applied to every
 * payload rather than left to the caller to remember.
 */
export type Level = "debug" | "info" | "warn" | "error";

/**
 * Matched as a SUBSTRING, not an exact name: the real risk is an env var like
 * `SUPABASE_SERVICE_ROLE_KEY` or `IMPORT_SECRET` landing in a payload, and an
 * anchored pattern misses every one of those.
 *
 * Deliberately not matching a bare `*_key` suffix — `rule_key`, `factor_key` and
 * `zone_code` carry no secret and are exactly what makes a log line useful.
 */
const SECRET_KEYS = /(authorization|cookie|password|passwd|secret|token|credential|service_role|anon_key|api_?key|access_?key|private_?key)/i;
const SECRET_VALUE = /(sb[ap]-[a-z0-9_-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/gi;

/** Strip anything that looks like a credential, at any depth. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[deep]";
  if (value == null) return value;
  if (typeof value === "string") return value.replace(SECRET_VALUE, "[redacted]").slice(0, 2000);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value instanceof Error) return { name: value.name, message: redact(value.message, depth + 1), stack: value.stack?.split("\n").slice(0, 6).join("\n") };
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL as Level) ?? "info"] ?? 20;

export function log(level: Level, event: string, data: Record<string, unknown> = {}): void {
  if (LEVELS[level] < threshold) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level, event,
    service: "sixgen-str-finder",
    ...(redact(data) as Record<string, unknown>),
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logInfo = (event: string, data?: Record<string, unknown>) => log("info", event, data);
export const logWarn = (event: string, data?: Record<string, unknown>) => log("warn", event, data);
export const logError = (event: string, error: unknown, data?: Record<string, unknown>) =>
  log("error", event, { ...data, error: redact(error) });

/** Client-side counterpart — the browser console, same shape. */
export function logClientError(boundary: string, error: Error & { digest?: string }): void {
  // eslint-disable-next-line no-console
  console.error(JSON.stringify({
    ts: new Date().toISOString(), level: "error", event: "client.boundary",
    boundary, message: error.message, digest: error.digest ?? null,
  }));
}

/** Wrap a route handler so failures are logged and answered consistently. */
export async function timed<T>(event: string, data: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  try {
    const result = await fn();
    logInfo(event, { ...data, ms: Date.now() - t0, ok: true });
    return result;
  } catch (e) {
    logError(event, e, { ...data, ms: Date.now() - t0, ok: false });
    throw e;
  }
}
