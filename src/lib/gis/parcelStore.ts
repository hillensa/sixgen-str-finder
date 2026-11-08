/**
 * Writing parcels to the cache.
 *
 * Every writer used to upsert on (jurisdiction_id, source_object_id), the
 * layer's ArcGIS ObjectID. Those are renumbered when the layer is republished,
 * so the 2026-11-07 sync re-inserted every parcel it touched: 1396 rows for 874
 * parcels. Duplicates are identical shapes, so spacing and the exclusion were
 * unaffected, but the density test sums dwelling units over parcels and would
 * have been halved.
 *
 * A parcel's identity is its PVA number, which the county does not renumber.
 * The ObjectID is kept only as a pointer to the current layer, and because a
 * republish can hand an old parcel's ObjectID to a different parcel, any stale
 * row still holding an incoming ObjectID is released (set null) first —
 * otherwise the (jurisdiction_id, source_object_id) unique key would refuse
 * the write.
 *
 * There is no unique index on pva_id (adding one needs a migration), so this is
 * lookup-then-write, like zoning_districts.
 */
export type ParcelWrite = {
  jurisdiction_id: string;
  source_object_id: number | null;
  pva_id: string | null;
  [k: string]: unknown;
};
type Existing = { id: number; pva_id: string | null; source_object_id: number | null };

export type ParcelPlan = {
  updates: (ParcelWrite & { id: number })[];
  inserts: ParcelWrite[];
  release: number[];          // ids whose source_object_id must be cleared first
  collapsed: number;          // incoming rows that repeated a parcel already in the batch
};

const keyOf = (r: { pva_id: string | null; source_object_id: number | null }) =>
  r.pva_id ? `pva:${r.pva_id.trim()}` : r.source_object_id != null ? `obj:${r.source_object_id}` : null;

/** Pure: decide updates, inserts and releases. */
export function planParcelWrites(incoming: ParcelWrite[], existing: Existing[]): ParcelPlan {
  // one row per parcel within the batch
  const seen = new Set<string>();
  const unique: ParcelWrite[] = [];
  for (const r of incoming) {
    const k = keyOf(r);
    if (k) { if (seen.has(k)) continue; seen.add(k); }
    unique.push(r);
  }

  const byPva = new Map<string, Existing>();
  const byObj = new Map<number, Existing[]>();
  for (const e of [...existing].sort((a, b) => a.id - b.id)) {
    if (e.pva_id && !byPva.has(e.pva_id.trim())) byPva.set(e.pva_id.trim(), e);
    if (e.source_object_id != null) byObj.set(e.source_object_id, [...(byObj.get(e.source_object_id) ?? []), e]);
  }

  const updates: (ParcelWrite & { id: number })[] = [];
  const inserts: ParcelWrite[] = [];
  const release = new Set<number>();
  for (const r of unique) {
    // match on PVA; a row with no PVA can only be matched on its ObjectID
    const target = r.pva_id ? byPva.get(r.pva_id.trim())
      : r.source_object_id != null ? byObj.get(r.source_object_id)?.[0] : undefined;
    if (target) updates.push({ ...r, id: target.id }); else inserts.push(r);
    if (r.source_object_id != null) {
      for (const h of byObj.get(r.source_object_id) ?? []) if (h.id !== target?.id) release.add(h.id);
    }
  }
  return { updates, inserts, release: [...release], collapsed: incoming.length - unique.length };
}

export type ParcelWriteResult = {
  inserted: number; updated: number; released: number; collapsed: number;
  /** stored id for each written parcel, by PVA number (and by ObjectID) */
  ids: { byPva: Map<string, number>; byObject: Map<number, number> };
  error?: string;
};

/** Write parcels: release stale ObjectIDs, update known parcels by id, insert new ones. */
export async function writeParcels(db: any, rows: ParcelWrite[]): Promise<ParcelWriteResult> {
  const result: ParcelWriteResult = { inserted: 0, updated: 0, released: 0, collapsed: 0, ids: { byPva: new Map(), byObject: new Map() } };
  if (!rows.length) return result;
  const jid = rows[0].jurisdiction_id;

  const pvas = [...new Set(rows.map((r) => r.pva_id?.trim()).filter((x): x is string => !!x))];
  const objs = [...new Set(rows.map((r) => r.source_object_id).filter((x): x is number => x != null))];
  const existing: Existing[] = [];
  for (let i = 0; i < pvas.length; i += 200) {
    const { data, error } = await db.from("parcels").select("id,pva_id,source_object_id")
      .eq("jurisdiction_id", jid).in("pva_id", pvas.slice(i, i + 200));
    if (error) return { ...result, error: `reading parcels: ${error.message}` };
    existing.push(...(data ?? []));
  }
  for (let i = 0; i < objs.length; i += 200) {
    const { data, error } = await db.from("parcels").select("id,pva_id,source_object_id")
      .eq("jurisdiction_id", jid).in("source_object_id", objs.slice(i, i + 200));
    if (error) return { ...result, error: `reading parcels: ${error.message}` };
    for (const e of data ?? []) if (!existing.some((x) => x.id === e.id)) existing.push(e);
  }

  const plan = planParcelWrites(rows, existing);
  result.collapsed = plan.collapsed;

  for (let i = 0; i < plan.release.length; i += 200) {
    const { error } = await db.from("parcels").update({ source_object_id: null }).in("id", plan.release.slice(i, i + 200));
    if (error) return { ...result, error: `releasing stale ObjectIDs: ${error.message}` };
  }
  result.released = plan.release.length;

  const record = (saved: any[] | null) => {
    for (const s of saved ?? []) {
      if (s.pva_id) result.ids.byPva.set(String(s.pva_id).trim(), s.id);
      if (s.source_object_id != null) result.ids.byObject.set(Number(s.source_object_id), s.id);
    }
  };
  // updates are an upsert on the primary key: one round trip per 200 rows
  for (let i = 0; i < plan.updates.length; i += 200) {
    const { data, error } = await db.from("parcels").upsert(plan.updates.slice(i, i + 200), { onConflict: "id" })
      .select("id,pva_id,source_object_id");
    if (error) return { ...result, error: `updating parcels: ${error.message}` };
    record(data); result.updated += data?.length ?? 0;
  }
  for (let i = 0; i < plan.inserts.length; i += 200) {
    const { data, error } = await db.from("parcels").insert(plan.inserts.slice(i, i + 200))
      .select("id,pva_id,source_object_id");
    if (error) return { ...result, error: `inserting parcels: ${error.message}` };
    record(data); result.inserted += data?.length ?? 0;
  }
  return result;
}
