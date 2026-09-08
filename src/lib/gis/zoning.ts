/**
 * Writing zoning districts to the cache.
 *
 * `zoning_districts_uniq` (migration 0003) is a PARTIAL unique index —
 * `... (jurisdiction_id, source_object_id) where source_object_id is not null`.
 * Postgres will not use a partial index to arbitrate `ON CONFLICT` unless the
 * statement repeats the same predicate, and PostgREST cannot express that. So
 * every `upsert(..., { onConflict: "jurisdiction_id,source_object_id" })` against
 * this table fails with "no unique or exclusion constraint matching the ON
 * CONFLICT specification".
 *
 * `resolveParcel` never checked the result of that call, so the zoning cache has
 * been silently empty: the Test Address screen still worked because it uses the
 * live ArcGIS answer it just fetched, but nothing was ever stored for
 * `fn_eligibility_facts` to read. That is why imported listings came back
 * ZONING_UNKNOWN.
 *
 * Look up, then insert or update. Same shape as the fix already applied to
 * sixgen_properties, which has a partial index for the same reason.
 */

export type ZoningRow = {
  jurisdiction_id: string;
  source_object_id: number;
  zone_code: string;
  ordinance_url: string | null;
  geom: unknown;
  fetched_at: string;
};

export async function upsertZoningDistricts(
  db: any,
  rows: ZoningRow[],
): Promise<{ written: number; error?: string }> {
  let written = 0;
  for (const row of rows) {
    const { data: hit } = await db.from("zoning_districts")
      .select("id")
      .eq("jurisdiction_id", row.jurisdiction_id)
      .eq("source_object_id", row.source_object_id)
      .maybeSingle();

    if (hit?.id) {
      const { error } = await db.from("zoning_districts").update(row).eq("id", hit.id);
      if (error) return { written, error: error.message };
    } else {
      const { error } = await db.from("zoning_districts").insert(row);
      // A concurrent writer can win the race; the unique index rejecting the
      // second insert is the correct outcome, not a failure worth reporting.
      if (error && !/duplicate key|unique constraint/i.test(error.message)) {
        return { written, error: error.message };
      }
    }
    written++;
  }
  return { written };
}
