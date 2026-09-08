import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/log";
export const dynamic = "force-dynamic";

const REQUIRED_ENV = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"];

/**
 * GET /api/health — the only route reachable without a session.
 *
 * It reports what a monitor actually needs to know: whether the app can reach
 * its database and whether the data it screens against is stale. It deliberately
 * exposes no counts, addresses or keys — an unauthenticated caller learns that
 * the service is up and nothing about the market.
 *
 * 200 = serving · 503 = degraded, do not trust results.
 */
export async function GET() {
  const started = Date.now();
  const checks: Record<string, { ok: boolean; detail?: string; ms?: number }> = {};

  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  checks.config = missing.length
    ? { ok: false, detail: `missing: ${missing.join(", ")}` }
    : { ok: true };

  let dataAgeHours: number | null = null;
  if (checks.config.ok) {
    const t = Date.now();
    try {
      // Server-side, service-role: every table in this app is RLS-scoped to
      // `authenticated`, and /api/health is deliberately public. Reading with
      // the anon key returns zero rows and NO error, so the freshness probe
      // silently reported "no exclusion zone" even with one sitting in the
      // table. Nothing privileged is returned from here — only booleans, a row
      // age, and timings.
      const s = createAdminClient();
      // This must stay a full GET, never a HEAD probe. A HEAD response carries
      // no body, so supabase-js has nothing to parse and reports success even
      // when the table does not exist — which is how this check came to pass
      // against a database with no schema in it at all.
      const { error } = await s.from("markets").select("id").limit(1);

      if (!error) {
        checks.database = { ok: true, ms: Date.now() - t };
      } else if (error.code === "PGRST205" || /Could not find the table/i.test(error.message)) {
        // reachable, but the migrations have not been run — a different repair
        checks.database = { ok: true, ms: Date.now() - t, detail: "reachable" };
        checks.schema = { ok: false, detail: "core tables are missing - run the migrations in supabase/migrations, then seed.sql" };
      } else {
        checks.database = { ok: false, detail: error.message, ms: Date.now() - t };
      }

      if (!error) {
        checks.schema = { ok: true };
        const { data: excl } = await s.from("market_exclusions").select("computed_at").limit(1).maybeSingle();
        if (excl?.computed_at) {
          dataAgeHours = Math.round((Date.now() - new Date(excl.computed_at).getTime()) / 36e5);
          // the 600-ft exclusion is the app's most perishable artifact
          checks.exclusion_freshness = dataAgeHours <= 24 * 14
            ? { ok: true }
            : { ok: false, detail: `exclusion zone is ${Math.round(dataAgeHours / 24)} days old` };
        } else {
          checks.exclusion_freshness = { ok: false, detail: "no exclusion zone has been built" };
        }
      }
    } catch (e: any) {
      logError("health.database", e);
      checks.database = { ok: false, detail: e.message, ms: Date.now() - t };
    }
  }

  // Freshness is a warning: the app still answers correctly, just from older
  // permits. A missing schema is not — every page would fail, so that is `down`.
  const serving = checks.config.ok && checks.database?.ok !== false && checks.schema?.ok !== false;
  const degraded = Object.values(checks).some((c) => !c.ok);

  return NextResponse.json({
    ok: serving,
    status: !serving ? "down" : degraded ? "degraded" : "healthy",
    service: "sixgen-str-finder",
    phase: 7,
    checks,
    dataAgeHours,
    uptimeMs: Math.round(process.uptime?.() * 1000) || null,
    ms: Date.now() - started,
    time: new Date().toISOString(),
  }, { status: serving ? 200 : 503, headers: { "cache-control": "no-store" } });
}
