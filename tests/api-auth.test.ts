import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * INVARIANT: every API route authenticates before it reads or writes.
 *
 * /api/rules used to query straight through the session client and let the RLS
 * refusal surface as a 400 with a Postgres message — a different answer to the
 * same question ("who are you?") than every other endpoint gave. Relying on RLS
 * alone also means a policy loosened later silently opens the route.
 */
const API_ROOT = join(__dirname, "..", "src", "app", "api");

/** Routes that are deliberately reachable without a session. */
const PUBLIC = new Set(["health"]);

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...routeFiles(p));
    else if (entry === "route.ts") out.push(p);
  }
  return out;
}

const files = routeFiles(API_ROOT);
const routeName = (f: string) => relative(API_ROOT, f).split(sep).slice(0, -1).join("/");

test("there are API routes to check", () => {
  assert.ok(files.length >= 10, `found only ${files.length} route files`);
});

test("INVARIANT: every non-public API route guards on a session before touching data", () => {
  const unguarded: string[] = [];
  for (const f of files) {
    const name = routeName(f);
    if (PUBLIC.has(name)) continue;
    const src = readFileSync(f, "utf8");
    const guarded =
      /requireAdmin\b/.test(src) ||
      /requireAdminOrSecret\b/.test(src) ||
      (/auth\.getUser\(\)/.test(src) && /status:\s*401/.test(src));
    if (!guarded) unguarded.push(name);
  }
  assert.deepEqual(unguarded, [], `these routes read or write without an auth guard: ${unguarded.join(", ")}`);
});

test("REGRESSION: /api/rules checks the session before it queries, not after", () => {
  const src = readFileSync(join(API_ROOT, "rules", "route.ts"), "utf8");
  const get = src.slice(src.indexOf("export async function GET"), src.indexOf("export async function POST"));
  assert.ok(/auth\.getUser\(\)/.test(get), "the GET handler must resolve the user");
  assert.ok(/status:\s*401/.test(get), "and answer 401, not a database error");
  assert.ok(
    get.indexOf("auth.getUser()") < get.indexOf('from("str_rules")'),
    "the guard must come before the query, or an RLS refusal still leaks as a 400",
  );
});

test("the health endpoint stays public on purpose", () => {
  const src = readFileSync(join(API_ROOT, "health", "route.ts"), "utf8");
  assert.ok(!/requireAdmin|auth\.getUser/.test(src), "health is the one route that must answer without a session");
});
