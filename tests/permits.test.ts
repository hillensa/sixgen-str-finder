import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { mapPermits, permitCounts } from "../src/lib/permits";

const sample = [
  { id: 1, address_norm: "300 SHERMAN AVE", address_raw: null, str_type: "unhosted", permit_status: "active", is_blocking: true, lat: 38.03, lng: -84.47, source: "city_gis", match_confidence: 0.95 },
  { id: 2, address_norm: "3865 GLADMAN WAY", address_raw: null, str_type: "hosted", permit_status: "active", is_blocking: false, lat: 38.0, lng: -84.55, source: "city_gis", match_confidence: 0.95 },
  { id: 3, address_norm: "1-BED CONDO", address_raw: null, str_type: "unhosted", permit_status: "active", is_blocking: true, lat: 38.04, lng: -84.5, source: "open_records", match_confidence: 0.6 },
  { id: 4, address_norm: "TYPE UNKNOWN", address_raw: null, str_type: null, permit_status: "unknown", is_blocking: null, lat: 38.05, lng: -84.49, source: "manual", match_confidence: null },
  { id: 5, address_norm: "NO COORDS YET", address_raw: "102 Rosemont Garden", str_type: "unhosted", permit_status: "active", is_blocking: true, lat: null, lng: null, source: "open_records", match_confidence: 0 },
];

test("INVARIANT: mapPermits returns every permit — nothing is dropped for size, value, type, status, or missing coordinates", () => {
  const out = mapPermits(sample as any);
  assert.equal(out.length, sample.length);
  assert.deepEqual(out.map((p) => p.id), sample.map((p) => p.id));
  const c = permitCounts(out);
  assert.equal(c.total, 5); assert.equal(c.blocking, 2); assert.equal(c.hosted, 1); assert.equal(c.unknown, 1); assert.equal(c.unlocated, 1);
});

test("INVARIANT: no module that touches str_permits imports the listing acquisition filters", () => {
  const files: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) && files.push(p); } };
  walk(join(__dirname, "..", "src"));
  const offenders = files.filter((f) => { const s = readFileSync(f, "utf8"); return /str_permits/.test(s) && /applyHardFilters|from "@\/lib\/filters"|from "\.\/filters"/.test(s); });
  assert.deepEqual(offenders, [], `These files apply listing filters near permit data: ${offenders.join(", ")}`);
});

test("INVARIANT: the market API selects permits with no type/price/bed predicate", () => {
  const src = readFileSync(join(__dirname, "..", "src/app/api/market/route.ts"), "utf8");
  const permitQuery = src.slice(src.indexOf('from("str_permits")'), src.indexOf('from("str_permits")') + 400);
  assert.ok(!/\.eq\("hosted"|\.eq\("str_type"|\.gte\(|\.lte\(|is_blocking",\s*true/.test(permitQuery), "market permit query must not filter by type or blocking flag");
});
