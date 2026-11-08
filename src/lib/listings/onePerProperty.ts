/**
 * One listing per house.
 *
 * A property can hold several active listings: the ImagineMLS export and a
 * Zillow search both carry the same MLS listing under different ids, and
 * `listings` is keyed on (market, provider, external_id). The candidate view
 * joins every listing to the property, so without this a house in both sources
 * is scored twice — skewing every relative factor, since the scorer ranks
 * yields against the pool — and appears twice in the Top 25.
 *
 * The winner is the listing seen most recently, because that is the one whose
 * price is current. Ties go to the listing that can be opened (a URL), then to
 * the newer row. Output keeps the order in which each property first appeared,
 * so a list already sorted by score stays sorted.
 */
export type ListingLike = { property_id: number; listing_id: number | null; url?: string | null };

export function onePerProperty<T extends ListingLike>(
  rows: T[],
  lastSeen: Map<number, string | null> = new Map(),
): T[] {
  const order: number[] = [];
  const best = new Map<number, T>();
  const seenAt = (r: T) => (r.listing_id != null ? lastSeen.get(r.listing_id) ?? "" : "");

  for (const r of rows) {
    const cur = best.get(r.property_id);
    if (!cur) { order.push(r.property_id); best.set(r.property_id, r); continue; }
    const a = seenAt(r), b = seenAt(cur);
    const better =
      a !== b ? a > b                                   // ISO timestamps compare as strings
      : !!r.url !== !!cur.url ? !!r.url
      : (r.listing_id ?? 0) > (cur.listing_id ?? 0);
    if (better) best.set(r.property_id, r);
  }
  return order.map((id) => best.get(id) as T);
}

/** How many rows were folded away — reported, so a collapse is never silent. */
export function duplicateCount(rows: ListingLike[]): number {
  return rows.length - new Set(rows.map((r) => r.property_id)).size;
}
