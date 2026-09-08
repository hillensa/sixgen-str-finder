/**
 * Listing refresh diff (spec §13, Phase 4).
 *
 * Pure: existing rows + the provider's current set in, a classified change list
 * out. The route does the I/O. Every outcome carries the reason it was reached,
 * because "12 removed" with no explanation is not something an operator can act
 * on.
 *
 * A refresh is deliberately conservative about disappearance. A listing missing
 * from the payload is only marked removed on a **full** sync — a partial paste
 * says nothing about the listings it does not mention.
 */
import type { NormalizedListing } from "../providers/listings";

export type ExistingListing = {
  id: number;
  externalId: string;
  propertyId: number;
  status: string;
  listPrice: number | null;
  originalPrice: number | null;
  removedAt: string | null;
  /** The property's stored pin, reused when a payload row arrives without one. */
  lat?: number | null;
  lng?: number | null;
};

export type ChangeKind = "new" | "price_change" | "status_change" | "relisted" | "unchanged" | "removed";

export type ListingChange = {
  kind: ChangeKind;
  externalId: string;
  listingId: number | null;
  /** Present for everything except `removed`. */
  incoming: NormalizedListing | null;
  existing: ExistingListing | null;
  previousPrice: number | null;
  newPrice: number | null;
  /** Negative = price cut. */
  priceDelta: number | null;
  pricePct: number | null;
  reason: string;
};

export type DiffCounts = Record<ChangeKind, number>;
export type DiffResult = { changes: ListingChange[]; counts: DiffCounts; received: number; duplicatesInPayload: number };

const money = (n: number) => `$${Math.round(n).toLocaleString()}`;

/**
 * @param fullSync when true, existing active listings absent from `incoming`
 *   are marked removed. Off by default: a partial payload is not evidence that
 *   anything was withdrawn.
 * @param protect external ids that appeared in the payload but could not be
 *   turned into a coordinate. They are exempt from removal on a full sync,
 *   because they were seen — absence is not what happened to them.
 */
export function diffListings(
  existing: ExistingListing[],
  incoming: NormalizedListing[],
  opts: { fullSync?: boolean; protect?: Set<string> } = {}
): DiffResult {
  const byExternal = new Map(existing.map((e) => [e.externalId, e]));
  const changes: ListingChange[] = [];
  const seen = new Set<string>();
  let duplicatesInPayload = 0;

  for (const l of incoming) {
    if (seen.has(l.externalId)) { duplicatesInPayload++; continue; }
    seen.add(l.externalId);

    const prior = byExternal.get(l.externalId);
    const base = {
      externalId: l.externalId,
      listingId: prior?.id ?? null,
      incoming: l,
      existing: prior ?? null,
      previousPrice: prior?.listPrice ?? null,
      newPrice: l.price,
    };

    if (!prior) {
      changes.push({ ...base, kind: "new", priceDelta: null, pricePct: null,
        reason: l.price != null ? `New listing at ${money(l.price)}.` : "New listing with no price published." });
      continue;
    }

    const wasGone = prior.removedAt != null || prior.status === "removed";
    const priceMoved = l.price != null && prior.listPrice != null && l.price !== prior.listPrice;
    const delta = priceMoved ? l.price! - prior.listPrice! : null;
    const pct = delta != null && prior.listPrice ? +((delta / prior.listPrice) * 100).toFixed(1) : null;

    if (wasGone) {
      changes.push({ ...base, kind: "relisted", priceDelta: delta, pricePct: pct,
        reason: priceMoved
          ? `Back on the market at ${money(l.price!)}, previously ${money(prior.listPrice!)}.`
          : "Back on the market at the same price." });
      continue;
    }
    if (priceMoved) {
      changes.push({ ...base, kind: "price_change", priceDelta: delta, pricePct: pct,
        reason: `${delta! < 0 ? "Cut" : "Raised"} from ${money(prior.listPrice!)} to ${money(l.price!)} (${pct! > 0 ? "+" : ""}${pct}%).` });
      continue;
    }
    if (l.status !== prior.status) {
      changes.push({ ...base, kind: "status_change", priceDelta: null, pricePct: null,
        reason: `Status moved from ${prior.status} to ${l.status}.` });
      continue;
    }
    // A first-seen price on a listing that had none is history worth keeping,
    // but it is not a change in asking price.
    changes.push({ ...base, kind: "unchanged", priceDelta: null, pricePct: null, reason: "No change." });
  }

  if (opts.fullSync) {
    for (const e of existing) {
      if (seen.has(e.externalId) || e.removedAt != null || e.status === "removed" || e.status === "sold") continue;
      // A row we could not geocode was PRESENT in the payload — we simply could
      // not place it. Removing it would report a listing as withdrawn on the
      // strength of a geocoder miss.
      if (opts.protect?.has(e.externalId)) continue;
      changes.push({
        kind: "removed", externalId: e.externalId, listingId: e.id,
        incoming: null, existing: e,
        previousPrice: e.listPrice, newPrice: null, priceDelta: null, pricePct: null,
        reason: "Absent from a full refresh of this provider's active set.",
      });
    }
  }

  const counts: DiffCounts = { new: 0, price_change: 0, status_change: 0, relisted: 0, unchanged: 0, removed: 0 };
  for (const c of changes) counts[c.kind]++;
  return { changes, counts, received: incoming.length, duplicatesInPayload };
}

/** The changes whose property should be re-screened — eligibility depends on these. */
export function needsRescreen(changes: ListingChange[]): ListingChange[] {
  return changes.filter((c) => c.kind === "new" || c.kind === "relisted");
}

/** A change worth writing to listing_price_history. */
export function isPricePoint(c: ListingChange): boolean {
  return c.newPrice != null && (c.kind === "new" || c.kind === "price_change" || (c.kind === "relisted" && c.priceDelta != null));
}

export function summarizeDiff(d: DiffResult, fullSync: boolean): string {
  const c = d.counts;
  const parts = [
    `${c.new} new`,
    `${c.price_change} price ${c.price_change === 1 ? "change" : "changes"}`,
    `${c.relisted} relisted`,
    `${c.status_change} status ${c.status_change === 1 ? "change" : "changes"}`,
    `${c.unchanged} unchanged`,
  ];
  parts.push(fullSync ? `${c.removed} removed` : "removals not evaluated (partial refresh)");
  if (d.duplicatesInPayload) parts.push(`${d.duplicatesInPayload} duplicate rows in the payload ignored`);
  return parts.join(" · ");
}
