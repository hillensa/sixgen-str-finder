/**
 * What makes two permit rows the same permit.
 *
 * Not the layer's ObjectID (`external_id`): ArcGIS renumbers those when a layer
 * is republished, which is how a refresh once inserted a second copy of every
 * permit in the county. And not the permit number alone either: the LFUCG layer
 * issues one number to more than one house — 15087540-1 covers both 4277
 * Steamboat Rd and 415 Chinoe Rd, two unhosted STRs that each block. Keyed on
 * the number alone, one of them would be merged into the other and vanish from
 * the spacing test, letting a nearby listing pass that should fail.
 *
 * So identity is permit number + normalized address. Rows the layer itself
 * repeats exactly (194 Swigert Ave appears twice under each of its three
 * numbers) collapse to one, which is what they are.
 */
export type PermitLike = { permit_number?: string | null; address_norm?: string | null };

export function permitIdentity(r: PermitLike): string | null {
  const pn = (r.permit_number ?? "").trim();
  if (!pn) return null;
  return `${pn}|${(r.address_norm ?? "").trim().toUpperCase()}`;
}

/** Keep the first row for each identity; rows with no permit number all pass through. */
export function dedupeByIdentity<T extends PermitLike>(rows: T[]): { rows: T[]; collapsed: number } {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    const id = permitIdentity(r);
    if (id) { if (seen.has(id)) continue; seen.add(id); }
    out.push(r);
  }
  return { rows: out, collapsed: rows.length - out.length };
}

/**
 * Point each incoming row at the stored row for the same permit, so the upsert
 * updates it instead of inserting a copy. The stored ObjectID is kept: it is
 * the conflict key the upsert resolves on.
 */
export function reconcileWithPrior<T extends PermitLike & { external_id: string; review_note?: string | null }>(
  incoming: T[],
  prior: (PermitLike & { id: number; external_id: string })[],
): (T & { id?: number })[] {
  const byIdentity = new Map<string, { id: number; external_id: string }>();
  for (const p of prior) { const k = permitIdentity(p); if (k && !byIdentity.has(k)) byIdentity.set(k, p); }
  return incoming.map((r) => {
    const k = permitIdentity(r);
    const p = k ? byIdentity.get(k) : undefined;
    // a known permit is plainly present again, so a stale "no longer present"
    // note is cleared rather than carried forward
    return p ? { ...r, id: p.id, external_id: p.external_id, review_note: r.review_note ?? null } : r;
  });
}

/** Stored permits whose identity is missing from the incoming set. */
export function missingFrom<T extends PermitLike>(prior: T[], incoming: PermitLike[]): T[] {
  const seen = new Set(incoming.map(permitIdentity).filter((x): x is string => !!x));
  return prior.filter((p) => { const k = permitIdentity(p); return !!k && !seen.has(k); });
}
