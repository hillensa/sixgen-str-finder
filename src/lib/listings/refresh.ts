/**
 * The listing refresh engine (Phase 4).
 *
 * provider → normalize → match or create the property → diff → write → re-screen
 * only what changed → audit.
 *
 * Lives here rather than in a route so that /api/listings/refresh and the older
 * /api/listings/import cannot drift apart.
 */
import type { ParsedListing, ListingsProvider } from "../providers/listings";
import { applyHardFilters, DEFAULT_FILTERS, type AcquisitionFilters } from "../filters";
import { classifyEligibility, factsFromRow } from "../eligibility";
import { geocodeMany, geocodeKey } from "../geocode";
import { diffListings, isPricePoint, summarizeDiff, type ExistingListing, type ListingChange } from "./diff";
import { cacheGisForPoints } from "./cacheGis";
import { writeOutcome } from "./outcome";
import {
  planCoordinates, applyGeocode, coordinateSummary, describeCoordinates,
  type LocatedListing, type UnresolvedListing, type GeocodeHit,
} from "./geolocate";

export type RefreshOptions = {
  marketId: string;
  provider: ListingsProvider;
  input?: string;
  /** Mark listings absent from the payload as removed. Off unless asked for. */
  fullSync?: boolean;
  /** Re-screen eligibility for properties this refresh created or revived. */
  rescreen?: boolean;
  /** Allow the US Census fallback when the city address points miss. Default on. */
  useCensus?: boolean;
  actor?: string | null;
  note?: string | null;
};

export type RefreshReport = {
  ok: true;
  refreshId: number | null;
  received: number;
  /** Listing rows actually written. `counts` describes the diff; this is the outcome. */
  written: number;
  counts: Record<string, number>;
  qualified: number;
  needsHoaVerification: number;
  /** Parcel and zoning polygons cached for the screened properties. */
  gisCache: { parcels: number; zoning: number; errors: string[] };
  /** Where each pin came from. `census` results are interpolated, not surveyed. */
  coordinates: { provider: number; knownProperty: number; addressPoint: number; census: number; unresolved: number };
  rescreened: number;
  eligibility: Record<string, number>;
  skipped: { externalId: string; reason: string }[];
  fullSync: boolean;
  message: string;
  changes: { kind: string; externalId: string; address: string | null; reason: string }[];
  elapsedMs: number;
};

const RESCREEN_BATCH = 100;

export async function runRefresh(db: any, opts: RefreshOptions): Promise<RefreshReport | { error: string; status: number }> {
  const t0 = Date.now();
  const { marketId, provider, fullSync = false, rescreen = true } = opts;

  let parsed: ParsedListing[];
  try { parsed = await provider.searchListings(marketId, { input: opts.input }); }
  catch (e: any) { return { error: `parse: ${e.message}`, status: 400 }; }

  if (!parsed.length) {
    return { error: "The provider returned no listings. Refusing to run a refresh that could only remove rows.", status: 400 };
  }

  // Hard filters are configuration, not code (spec §14).
  const { data: filterRow } = await db.from("app_settings").select("value").eq("key", "acquisition_filters").maybeSingle();
  const filters: AcquisitionFilters = { ...DEFAULT_FILTERS, ...(filterRow?.value ?? {}) };

  const { data: existingRows, error: exErr } = await db
    .from("listings")
    .select("id,external_id,property_id,status,list_price,original_price,removed_at,properties(lat,lng)")
    .eq("market_id", marketId).eq("provider", provider.id);
  if (exErr) return { error: `reading current listings: ${exErr.message}`, status: 500 };

  const existing: ExistingListing[] = (existingRows ?? []).map((r: any) => ({
    id: r.id, externalId: r.external_id, propertyId: r.property_id,
    status: r.status, listPrice: r.list_price, originalPrice: r.original_price, removedAt: r.removed_at,
    lat: r.properties?.lat ?? null, lng: r.properties?.lng ?? null,
  }));

  // ── coordinates ──────────────────────────────────────────────────────────
  // An MLS export usually has no lat/lng column, so resolve the pin before
  // anything is written: payload → the pin we already stored → geocoder.
  // One lookup serves both the geocoder and the parcel/zoning cache below.
  const { data: jur } = await db.from("jurisdictions")
    .select("id,gis_address_url,gis_parcel_url,gis_zoning_url,markets(proj4,srid_feet)")
    .eq("market_id", marketId).limit(1).maybeSingle();

  const known = new Map(existing.map((e) => [e.externalId, { lat: e.lat ?? null, lng: e.lng ?? null }]));
  const plan = planCoordinates(parsed, known);
  let located: LocatedListing[] = plan.located;
  let unresolved: UnresolvedListing[] = [];

  if (plan.needGeocode.length) {
    if (!jur) {
      unresolved = plan.needGeocode.map((p) => ({
        externalId: p.externalId, address: p.address,
        reason: `No jurisdiction is configured for market ${marketId}, so this row could not be geocoded.`,
      }));
    } else {
      let hits: Map<string, GeocodeHit | null>;
      try {
        hits = (await geocodeMany(db, jur as any,
          plan.needGeocode.map((p) => ({ address: p.address, zip: p.zip ?? null })),
          { useCensus: opts.useCensus !== false, concurrency: 6 },
        )) as Map<string, GeocodeHit | null>;
      } catch (e: any) {
        return { error: `geocoding: ${e.message}`, status: 502 };
      }
      const applied = applyGeocode(plan.needGeocode, hits, geocodeKey);
      located = [...located, ...applied.located];
      unresolved = applied.unresolved;
    }
  }

  if (!located.length) {
    return {
      error: `None of the ${parsed.length} rows could be given a coordinate, so nothing can be screened. Add latitude and longitude columns to the export.`,
      status: 400,
    };
  }

  const coordinates = coordinateSummary(located, unresolved);

  // A row we failed to locate was present in the payload, so a full sync must
  // not read it as withdrawn.
  const diff = diffListings(existing, located, {
    fullSync,
    protect: new Set(unresolved.map((u) => u.externalId)),
  });

  const { data: refreshRow } = await db.from("listing_refreshes").insert({
    market_id: marketId, provider: provider.id, status: "processing",
    received: diff.received, full_sync: fullSync, actor: opts.actor ?? null, actor_note: opts.note ?? null,
  }).select("id").single();
  const refreshId: number | null = refreshRow?.id ?? null;

  const fail = async (message: string, status = 500) => {
    if (refreshId) await db.from("listing_refreshes").update({ status: "failed", message, finished_at: new Date().toISOString() }).eq("id", refreshId);
    return { error: message, status };
  };

  const now = new Date().toISOString();
  let qualified = 0, needsHoa = 0;
  // Writes attempted vs writes that landed. `diff.counts` describes the diff,
  // not the outcome, so a row that fails to write is subtracted from it below —
  // reporting "6 new" alongside "6 skipped" tells the operator nothing true.
  let attemptedWrites = 0, written = 0;
  const writeFailures: string[] = [];
  const rescreenIds = new Set<number>();
  // Coordinates of the properties that will be screened — the parcel and zoning
  // caches are filled for exactly these before the spatial link runs.
  const screenPoints: { lng: number; lat: number }[] = [];
  // Rows we could not place start here, so they are reported rather than lost.
  const skipped: { externalId: string; reason: string }[] =
    unresolved.map((u) => ({ externalId: u.externalId, reason: u.reason }));
  // How each pin was obtained, keyed by external id — the diff carries the
  // listing, not its provenance.
  const provenance = new Map(located.map((l) => [l.externalId, l]));

  // ── upserts ──────────────────────────────────────────────────────────────
  for (const c of diff.changes) {
    if (c.kind === "removed") continue;
    const l = c.incoming!;
    attemptedWrites++;
    // A change that cannot be written did not happen; take it back out of the
    // diff counts so the reported totals match what is in the database.
    const abandon = (reason: string) => {
      skipped.push({ externalId: l.externalId, reason });
      writeFailures.push(reason);
      diff.counts[c.kind]--;
    };

    // One house, one property row. Phase 1 inserted unconditionally, so the same
    // address arriving from a second provider became a second property.
    let propertyId: number | null = c.existing?.propertyId ?? null;
    if (!propertyId) {
      const { data: matched } = await db.rpc("fn_match_property", {
        p_market: marketId, p_address_norm: l.addressNorm, p_unit: l.unit ?? null,
        p_lat: l.lat, p_lng: l.lng,
      });
      propertyId = (matched as number | null) ?? null;
    }

    const propRow = {
      market_id: marketId, address: l.address, address_norm: l.addressNorm, unit: l.unit ?? null,
      zip: l.zip ?? null, lat: l.lat, lng: l.lng,
      beds: l.beds, baths: l.baths ?? null, sqft: l.sqft ?? null, lot_sqft: l.lotSqft ?? null,
      year_built: l.yearBuilt ?? null, property_type: l.propertyType ?? null, stories: l.stories ?? null,
      garage: l.garage ?? null, pool: l.pool ?? null, basement: l.basement ?? null, finished_basement: l.finishedBasement ?? null,
      hoa_status: l.hoaStatus, hoa_fee_monthly: l.hoaFeeMonthly ?? null, hoa_name: l.hoaName ?? null,
      // Provenance travels with the pin. fn_link_properties_to_parcels caps the
      // parcel match confidence by this, so an interpolated Census coordinate
      // trips LOW_PARCEL_CONFIDENCE instead of passing as a surveyed point.
      geocode_method: provenance.get(l.externalId)?.coordinateSource ?? "provider",
      geocode_confidence: provenance.get(l.externalId)?.coordinateConfidence ?? 1,
      updated_at: now,
    };

    if (propertyId) {
      await db.from("properties").update(propRow).eq("id", propertyId);
    } else {
      // The identity index is on an expression (coalesce(unit,'')), which
      // PostgREST cannot target with on_conflict, so insert and let the unique
      // index arbitrate: a concurrent writer wins and we re-read its row.
      const { data: created, error } = await db.from("properties").insert(propRow).select("id").single();
      if (error || !created) {
        const { data: again } = await db.rpc("fn_match_property", {
          p_market: marketId, p_address_norm: l.addressNorm, p_unit: l.unit ?? null, p_lat: l.lat, p_lng: l.lng,
        });
        propertyId = (again as number | null) ?? null;
        if (!propertyId) { abandon(error?.message ?? "could not resolve a property"); continue; }
        await db.from("properties").update(propRow).eq("id", propertyId);
      } else propertyId = created.id;
    }
    if (!propertyId) { abandon("could not resolve a property for this listing"); continue; }
    // Eligibility depends on the property, so only a house that is newly in the
    // pool needs re-screening; a price move does not change the 600-ft answer.
    if (c.kind === "new" || c.kind === "relisted") {
      rescreenIds.add(propertyId);
      screenPoints.push({ lng: l.lng, lat: l.lat });
    }

    const listRow: Record<string, any> = {
      property_id: propertyId, market_id: marketId, provider: provider.id, external_id: l.externalId,
      status: l.status, list_price: l.price,
      original_price: c.existing?.originalPrice ?? l.originalPrice ?? l.price,
      days_on_market: l.daysOnMarket ?? null, listed_at: l.listedAt ?? null,
      url: l.url ?? null, primary_photo: l.primaryPhoto ?? null, description: l.description ?? null,
      brokerage: l.brokerage ?? null, agent: l.agent ?? null, raw: l.raw ?? null,
      last_seen: now, removed_at: null,
    };
    if (c.kind === "price_change" || (c.kind === "relisted" && c.priceDelta != null)) {
      listRow.previous_price = c.previousPrice;
      listRow.price_changed_at = now;
    }

    const { data: saved, error: listErr } = await db.from("listings")
      .upsert(listRow, { onConflict: "market_id,provider,external_id" })
      .select("id").single();
    if (listErr || !saved) return fail(`writing listings: ${listErr?.message ?? "no row returned"}`);
    c.listingId = saved.id;
    written++;

    if (isPricePoint(c)) {
      await db.from("listing_price_history").insert({ listing_id: saved.id, price: c.newPrice, source: provider.id });
    }

    const f = applyHardFilters({ beds: l.beds, price: l.price, hoa_status: l.hoaStatus, status: l.status }, filters);
    if (f.qualified) qualified++;
    if (f.needsHoaVerification) needsHoa++;
  }

  // A run that attempted writes and landed none is a failed run, not a quiet one.
  const outcome = writeOutcome(attemptedWrites, written, writeFailures);
  if (!outcome.ok) return fail(outcome.error!, 500);

  // ── removals ─────────────────────────────────────────────────────────────
  const removed = diff.changes.filter((c) => c.kind === "removed" && c.listingId);
  if (removed.length) {
    const { error } = await db.from("listings")
      .update({ removed_at: now, status: "removed" })
      .in("id", removed.map((c) => c.listingId));
    if (error) return fail(`marking removals: ${error.message}`);
  }

  // ── re-screen only what changed ──────────────────────────────────────────
  const eligibility: Record<string, number> = {};
  let gisCache = { parcels: 0, zoning: 0, errors: [] as string[] };
  let rescreened = 0;
  const idsToScreen = rescreen ? [...rescreenIds] : [];

  if (idsToScreen.length) {
    // Fill the parcel and zoning caches for these properties FIRST. The link and
    // the facts functions both read cached geometry only, so without this a
    // listing away from any STR permit has nothing to match and is screened from
    // a bare point — PARCEL_NOT_MATCHED and ZONING_UNKNOWN on merit it may not
    // deserve.
    if (jur?.markets) {
      const cached = await cacheGisForPoints(db, jur as any, (jur as any).markets, screenPoints);
      gisCache = { parcels: cached.parcels, zoning: cached.zoning, errors: cached.errors };
    }
    await db.rpc("fn_link_properties_to_parcels", { p_market: marketId });
    for (let i = 0; i < idsToScreen.length; i += RESCREEN_BATCH) {
      const slice = idsToScreen.slice(i, i + RESCREEN_BATCH);
      const { data: facts, error } = await db.rpc("fn_eligibility_facts_for_properties", { p_property_ids: slice });
      if (error) return fail(`re-screening: ${error.message}`);

      const rows = (facts ?? []).map((row: any) => {
        const result = classifyEligibility(factsFromRow(row));
        return {
          row: {
            property_id: row.property_id, rules_version: row.rules_version ?? "unversioned",
            classification: result.classification, summary: result.summary, cup_required: result.cupRequired,
            parcel_id: row.parcel_id ?? null, subject_source: row.subject_source ?? null,
            zone_code: row.zone_code ?? null, zone_ordinance_url: row.zone_ordinance_url ?? null,
            zoning_treatment: row.zoning_treatment ?? null,
            spacing_result: row.spacing_result ?? null, spacing_ft: row.spacing_ft ?? null,
            spacing_measured: row.spacing_measured ?? null,
            nearest_str_permit_id: row.nearest_permit_id ?? null,
            nearest_str_distance_ft: row.nearest_distance_ft ?? null,
            density_result: row.density_result ?? null, density_radius_ft: row.density_radius_ft ?? null,
            density_threshold_pct: row.density_threshold_pct ?? null, density_units: row.density_units ?? null,
            density_strs: row.density_strs ?? null, density_pct: row.density_pct ?? null,
            density_pct_after: row.density_pct_after ?? null,
            hoa_status: row.hoa_status ?? "HOA_UNKNOWN",
            parcel_match_confidence: row.parcel_match_confidence ?? null,
            details: { nearestAddress: row.nearest_address ?? null, trigger: "listing_refresh" },
          },
          failures: result.failures,
        };
      });
      if (!rows.length) continue;

      const { data: inserted, error: insErr } = await db.from("eligibility_checks")
        .insert(rows.map((r: any) => r.row)).select("id,property_id,classification");
      if (insErr) return fail(`writing eligibility: ${insErr.message}`);

      const byProperty = new Map((inserted ?? []).map((r: any) => [r.property_id, r.id]));
      const failureRows = rows.flatMap((r: any) => {
        const checkId = byProperty.get(r.row.property_id);
        return checkId ? r.failures.map((f: any) => ({
          eligibility_check_id: checkId, code: f.code, severity: f.severity, message: f.message, evidence: f.evidence ?? null,
        })) : [];
      });
      if (failureRows.length) await db.from("eligibility_failures").insert(failureRows);

      for (const r of inserted ?? []) eligibility[r.classification] = (eligibility[r.classification] ?? 0) + 1;
      rescreened += inserted?.length ?? 0;
    }
  }

  const coordNote = describeCoordinates(coordinates);
  const message = summarizeDiff(diff, fullSync) + (coordNote ? ` · ${coordNote}` : "");
  if (refreshId) {
    await db.from("listing_refreshes").update({
      status: "complete", message, finished_at: new Date().toISOString(),
      new_count: diff.counts.new, price_changes: diff.counts.price_change,
      removed: diff.counts.removed, relisted: diff.counts.relisted, unchanged: diff.counts.unchanged,
      qualified, rescreened,
    }).eq("id", refreshId);
  }

  return {
    ok: true, refreshId, received: diff.received, written, counts: diff.counts,
    qualified, needsHoaVerification: needsHoa, coordinates, gisCache, rescreened, eligibility, skipped, fullSync, message,
    changes: diff.changes
      .filter((c) => c.kind !== "unchanged")
      .slice(0, 200)
      .map((c: ListingChange) => ({
        kind: c.kind, externalId: c.externalId,
        address: c.incoming?.address ?? null, reason: c.reason,
      })),
    elapsedMs: Date.now() - t0,
  };
}
