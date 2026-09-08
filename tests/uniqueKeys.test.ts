import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Every `.upsert(..., { onConflict })` must name a unique key Postgres will
 * actually use to arbitrate the conflict.
 *
 * Postgres will NOT use a PARTIAL unique index for `ON CONFLICT` unless the
 * statement repeats the index predicate, and it will not match an EXPRESSION
 * index from a plain column list. PostgREST can express neither. An upsert
 * against one of those fails at runtime with
 *
 *   "there is no unique or exclusion constraint matching the ON CONFLICT
 *    specification"
 *
 * which is a 500 in the middle of a write, not a compile error. This project has
 * been bitten three times — sixgen_properties, zoning_districts, and the
 * properties identity index — each time discovered only by running an import
 * against the live database. Once was an accident; three times means the rule
 * belongs in the suite rather than in three separate comments.
 *
 * The checks are source-level because the constraint lives in SQL and the caller
 * lives in TypeScript; nothing at compile time relates the two.
 */

const ROOT = join(__dirname, "..");
const norm = (cols: string) => cols.split(",").map((c) => c.trim().toLowerCase()).join(",");

type Kind = "plain" | "partial" | "expression";
type Key = { table: string; name: string; cols: string; kind: Kind };

function migrationSql(): string {
  const dir = join(ROOT, "supabase", "migrations");
  return readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()
    .map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
}

/** Every unique key the schema defines, and whether ON CONFLICT can name it. */
function uniqueKeys(sql: string): Key[] {
  const keys: Key[] = [];
  const add = (table: string, name: string, cols: string, partial: boolean) =>
    keys.push({
      table: table.toLowerCase(), name, cols: norm(cols),
      kind: partial ? "partial" : cols.includes("(") ? "expression" : "plain",
    });

  // create unique index [if not exists] N on T (cols) [where ...];
  const idx = /create\s+unique\s+index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?(\w+)\s+on\s+(?:public\.)?(\w+)\s*\(([^;]*?)\)\s*(where[^;]*)?;/gi;
  for (let m = idx.exec(sql); m; m = idx.exec(sql)) add(m[2], m[1], m[3], !!m[4]);

  // alter table T add constraint C unique (cols)
  const alt = /alter\s+table\s+(?:public\.)?(\w+)[\s\S]{0,80}?add\s+constraint\s+(\w+)\s+unique\s*\(([^)]*)\)/gi;
  for (let m = alt.exec(sql); m; m = alt.exec(sql)) add(m[1], m[2], m[3], false);

  // inline: create table T ( ... ), covering `unique (a,b)`, `primary key (a,b)`,
  // and a column marked `unique` or `primary key` on its own line
  const tbl = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?(\w+)\s*\(([\s\S]*?)\n\);/gi;
  for (let m = tbl.exec(sql); m; m = tbl.exec(sql)) {
    const [table, body] = [m[1], m[2]];
    const tuple = /(?:^|\s)(?:unique|primary\s+key)\s*\(([^)]*)\)/gi;
    for (let u = tuple.exec(body); u; u = tuple.exec(body)) add(table, "(inline)", u[1], false);
    const col = /^\s*(\w+)\s+[\w\s()]*?\b(?:unique|primary\s+key)\b/gim;
    for (let u = col.exec(body); u; u = col.exec(body)) add(table, "(inline col)", u[1], false);
  }
  return keys;
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) return tsFiles(p);
    return /\.tsx?$/.test(e) ? [p] : [];
  });
}

/** Each `.from("t") … .upsert(…, { onConflict: "…" })` in the app. */
function upserts(): { file: string; line: number; table: string; onConflict: string }[] {
  const out: { file: string; line: number; table: string; onConflict: string }[] = [];
  for (const path of tsFiles(join(ROOT, "src"))) {
    const s = readFileSync(path, "utf8");
    const from = /from\(\s*"(\w+)"\s*\)/g;
    for (let m = from.exec(s); m; m = from.exec(s)) {
      const window = s.slice(m.index + m[0].length, m.index + m[0].length + 1400);
      const up = window.search(/\.upsert\(/);
      if (up < 0) continue;
      if (/from\(\s*"/.test(window.slice(0, up))) continue;   // a later, unrelated statement
      const oc = /onConflict:\s*"([^"]+)"/.exec(window.slice(up, up + 900));
      if (!oc) continue;
      out.push({
        file: path.slice(ROOT.length + 1).replace(/\\/g, "/"),
        line: s.slice(0, m.index).split("\n").length,
        table: m[1].toLowerCase(),
        onConflict: norm(oc[1]),
      });
    }
  }
  return out;
}

// ── the rule ───────────────────────────────────────────────────────────────
test("every upsert names a unique key that ON CONFLICT can actually use", () => {
  const keys = uniqueKeys(migrationSql());
  const found = upserts();
  assert.ok(found.length >= 8, `expected to find the app's upserts, saw ${found.length} — the scanner is broken`);

  const bad: string[] = [];
  for (const u of found) {
    const matches = keys.filter((k) => k.table === u.table && k.cols === u.onConflict);
    if (!matches.length) {
      bad.push(`${u.file}:${u.line} — ${u.table}(${u.onConflict}) matches no unique key or primary key`);
    } else if (!matches.some((k) => k.kind === "plain")) {
      bad.push(`${u.file}:${u.line} — ${u.table}(${u.onConflict}) resolves only to ${matches[0].name}, `
        + `which is ${matches[0].kind}; ON CONFLICT cannot use it. Look up the row, then insert or update.`);
    }
  }
  assert.deepEqual(bad, [], "\n  " + bad.join("\n  "));
});

test("the keys ON CONFLICT cannot use are known, so adding another is deliberate", () => {
  // Not a prohibition — a partial index is often right. But a new one silently
  // breaks any upsert written against it, so it has to be added here on purpose.
  const unusable = uniqueKeys(migrationSql())
    .filter((k) => k.kind !== "plain")
    .map((k) => `${k.table}.${k.name}`)
    .sort();
  assert.deepEqual(unusable, [
    "properties.properties_identity_uniq",       // coalesce(unit,'') — expression AND partial
    "sixgen_properties.sixgen_properties_guesty_uniq",
    "str_rules.str_rules_uniq",                  // coalesce() over two columns
    "zoning_districts.zoning_districts_uniq",
  ], "a unique key that ON CONFLICT cannot use was added or removed — see the note at the top of this file");
});

test("the tables behind those keys are written by lookup-then-write", () => {
  // The three that application code writes. str_rules is seeded from SQL.
  for (const f of ["src/lib/gis/parcel.ts", "src/lib/listings/cacheGis.ts", "src/app/api/sixgen/import/route.ts"]) {
    const s = readFileSync(join(ROOT, f), "utf8");
    for (const table of ["zoning_districts", "sixgen_properties"]) {
      assert.ok(
        !new RegExp(`from\\("${table}"\\)[\\s\\S]{0,200}\\.upsert\\(`).test(s),
        `${f} upserts ${table}, whose unique index ON CONFLICT cannot use`,
      );
    }
  }
});

test("properties is inserted and left to the index to arbitrate, not upserted", () => {
  // properties_identity_uniq is on coalesce(unit,''), which PostgREST cannot
  // name at all. refresh.ts inserts and re-reads on the resulting error.
  const s = readFileSync(join(ROOT, "src/lib/listings/refresh.ts"), "utf8");
  assert.ok(!/from\("properties"\)[\s\S]{0,200}\.upsert\(/.test(s));
  assert.ok(/fn_match_property/.test(s), "the re-read path must still be there");
});
