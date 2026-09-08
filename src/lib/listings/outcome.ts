/**
 * Whether a refresh that skipped rows still counts as a run.
 *
 * Pure, and deliberately in its own module: `refresh.ts` pulls in proj4 and the
 * ArcGIS client, and this decision needs neither. Keeping it separate means it
 * can be reasoned about — and tested — without a projection library loaded.
 */

/**
 * A refresh that wrote nothing, while every row it attempted failed, is a
 * failure — even though each row was individually reported. Returning 200 with
 * `written: 0` is precisely how a broken scheduled import goes unnoticed for a
 * week: the cron sees a success, the operator sees a listing count that simply
 * stopped moving.
 */
export function writeOutcome(
  attempted: number,
  written: number,
  failures: string[],
): { ok: boolean; error?: string } {
  if (written > 0 || attempted === 0 || !failures.length) return { ok: true };
  const distinct = [...new Set(failures)];
  return {
    ok: false,
    error: `All ${attempted} listings failed to write, so nothing was recorded. ${distinct.slice(0, 3).join(" · ")}`,
  };
}
