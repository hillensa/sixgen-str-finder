"use client";
import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { Badge } from "@/components/ui/badge";
import type { Layers, PermitPin, CandidatePin } from "@/components/MapView";
const MapView = dynamic(() => import("@/components/MapView"), { ssr: false, loading: () => <div className="flex h-full items-center justify-center text-slate-400">Loading map…</div> });

/**
 * Where a double-click should take you.
 *
 * The feed's own listing URL when it has one. The ImagineMLS export carries no
 * URL column, so the fallback is a Zillow address search — public, no login,
 * and it lands on the property or a short result list. The MLS number stays on
 * the row for looking it up in flexmls directly, which needs a session this
 * link cannot carry.
 */
function listingUrl(c: CandidatePin): string {
  if (c.url) return c.url;
  const q = [c.address, "Lexington", "KY", c.zip].filter(Boolean).join(" ");
  return `https://www.zillow.com/homes/${encodeURIComponent(q)}_rb/`;
}

export default function MapPage() {
  const [data, setData] = useState<any>(null); const [err, setErr] = useState<string | null>(null);
  const [layers, setLayers] = useState<Layers>({ exclusion: true, permits: true, candidates: true, blocked: false, parcels: false, zoning: false, boundary: true });
  const [flyTo, setFlyTo] = useState<any>(null); const [q, setQ] = useState(""); const [res, setRes] = useState<any[]>([]);
  const [probe, setProbe] = useState<any>(null); const [hl, setHl] = useState<any>(null);
  const [candidates, setCandidates] = useState<CandidatePin[]>([]);
  const [blocked, setBlocked] = useState<CandidatePin[]>([]);
  const [hovered, setHovered] = useState<number | null>(null);
  // The hovered row's card, anchored to that row. Kept as viewport coordinates
  // because the card is fixed-position — the list scrolls under it.
  const [preview, setPreview] = useState<{ c: CandidatePin; top: number } | null>(null);
  const [spacingFt, setSpacingFt] = useState<number | null>(null);

  // The separation radius is a rule, not a constant. It still ships marked
  // "(verify)" pending LFUCG Planning, so the circle has to follow str_rules.
  useEffect(() => {
    fetch("/api/rules?jurisdiction=lfucg")
      .then((r) => r.json())
      .then((j) => {
        const r = (j.rules ?? []).find((x: any) => x.rule_key === "spacing_ft" && x.enabled);
        setSpacingFt(r?.value_num != null ? Number(r.value_num) : null);
      })
      .catch(() => setSpacingFt(null));
  }, []);

  // Ranked candidates come from the same endpoint Top 25 renders, so the map and
  // the table can never disagree about who is #1.
  useEffect(() => {
    fetch("/api/scores?market=lexington-ky&limit=25")
      .then((r) => r.json())
      .then((j) => {
        setCandidates((j.top ?? []).filter((c: any) => c.lat != null && c.lng != null));
        // Off by default and counted separately: these are the listings the
        // separation rule already rejected, not near-misses in the ranking.
        setBlocked(j.spacingFailed ?? []);
      })
      .catch(() => { setCandidates([]); setBlocked([]); });
  }, []);

  useEffect(() => { fetch("/api/market").then(async (r) => r.ok ? r.json() : Promise.reject((await r.json()).error)).then(setData).catch((e) => setErr(String(e))); }, []);
  useEffect(() => { if (q.trim().length < 3) return setRes([]); const t = setTimeout(async () => { const j = await (await fetch(`/api/search?q=${encodeURIComponent(q)}`)).json(); setRes(j.results ?? []); }, 300); return () => clearTimeout(t); }, [q]);

  async function probeAt(lat: number, lng: number) {
    setProbe({ loading: true, lat, lng });
    const j = await (await fetch(`/api/gis/parcel-at?lat=${lat}&lng=${lng}`)).json();
    setProbe({ ...j, lat, lng }); setHl(j.parcel?.geometry ?? null);
  }

  if (err) return <div className="p-8 text-sm text-red-700">Couldn&apos;t load the map: {err}. Run the migrations + seed, then reload.</div>;
  if (!data) return <div className="flex h-full items-center justify-center text-sm text-slate-500">Loading market…</div>;
  const permits: PermitPin[] = data.permits.filter((p: any) => p.lat != null && p.lng != null); // unlocated permits are counted below, not silently lost
  const pc = data.permitCounts ?? { total: permits.length, blocking: 0, hosted: 0, unknown: 0, unlocated: 0 };

  return (
    <div className="relative h-full">
      <MapView center={[data.market.center_lat, data.market.center_lng]} zoom={data.market.default_zoom} jurisdictionId={data.jurisdiction?.id ?? "lfucg"} permits={permits} candidates={candidates} blocked={blocked} hoveredCandidate={hovered} spacingFt={spacingFt} exclusion={data.exclusion} layers={layers} flyTo={flyTo} onMapClick={probeAt} highlight={hl} />

      <div className="absolute left-14 top-3 z-[1250] w-[280px]">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a Lexington address…" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-lg outline-none" />
        {res.length > 0 && <div className="mt-1 max-h-56 overflow-auto rounded-lg bg-white shadow-xl">{res.map((r) => <div key={r.address} onClick={() => { setFlyTo({ lat: r.lat, lng: r.lng, zoom: 18, nonce: Date.now() }); setRes([]); setQ(r.address); probeAt(r.lat, r.lng); }} className="cursor-pointer border-b border-slate-100 px-3 py-2 text-xs hover:bg-slate-50">{r.address}</div>)}</div>}
      </div>

      {/* The ranked list, beside the map rather than on another page: the
          question "which of these is worth driving to" needs the position and
          the yield in one view. Clicking a row flies to its pin. */}
      {candidates.length > 0 && layers.candidates && (
        <div className="absolute right-3 top-3 z-[1200] flex max-h-[calc(100%-1.5rem)] w-[310px] flex-col rounded-lg bg-white/95 shadow-lg backdrop-blur">
          <div className="border-b border-slate-200 px-3 py-2">
            <div className="text-sm font-bold text-navy">Top {candidates.length}</div>
            <div className="text-[10px] text-slate-500">
              Hover a row for its details, click to fly to it on the map,
              or use the Zillow link to see the house.<br />
              Gross yield = forecast revenue &divide; list price. Revenue is modelled from
              Sixgen&apos;s own trailing twelve, before expenses and financing.
            </div>
          </div>
          <div className="overflow-y-auto">
            {candidates.map((c, i) => {
              const rank = c.rank ?? i + 1;
              const yieldPct = c.gross_yield_pct == null ? null : Number(c.gross_yield_pct);
              const tone = c.classification === "GREEN" ? "pass" : c.classification === "RED" ? "fail" : "review";
              return (
                <div key={c.property_id} className="group relative border-b border-slate-100">
                <button
                  onMouseEnter={(e) => { setHovered(c.property_id); setPreview({ c, top: e.currentTarget.getBoundingClientRect().top }); }}
                  onMouseLeave={() => { setHovered((h) => (h === c.property_id ? null : h)); setPreview((p) => (p?.c.property_id === c.property_id ? null : p)); }}
                  onClick={() => { setFlyTo({ lat: c.lat, lng: c.lng, zoom: 17, nonce: Date.now() }); probeAt(c.lat, c.lng); }}
                  onDoubleClick={() => window.open(listingUrl(c), "_blank", "noopener,noreferrer")}
                  title="Click to fly to it on the map"
                  className="flex w-full items-start gap-2 px-3 py-2 pb-5 text-left hover:bg-amber-50"
                >
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gold text-[10px] font-bold text-navy">{rank}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-semibold text-navy">{c.address ?? "—"}</span>
                    {c.external_id && <span className="block text-[10px] text-slate-400">MLS {c.external_id}</span>}
                    <span className="block text-[11px] text-slate-500">
                      {c.list_price != null ? `$${Math.round(c.list_price).toLocaleString()}` : "—"}
                      {c.beds ? ` · ${c.beds} bd` : ""}
                    </span>
                    <span className="block text-[11px] text-slate-600">
                      {c.forecast_revenue != null
                        ? <>est. revenue <b className="text-navy">${Math.round(Number(c.forecast_revenue)).toLocaleString()}</b>/yr</>
                        : <span className="text-slate-400">no revenue forecast</span>}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className={`block text-xs font-bold ${yieldPct != null && yieldPct >= 20 ? "text-green-700" : "text-navy"}`}>
                      {yieldPct != null ? `${yieldPct.toFixed(1)}%` : "—"}
                    </span>
                    <Badge tone={tone as any}>{c.score == null ? "—" : Number(c.score).toFixed(0)}</Badge>
                  </span>
                </button>
                {/* A visible single-click target. The double-click on the row
                    still works, but an invisible gesture is not an affordance —
                    nothing on screen said the row could be opened. */}
                <a
                  href={listingUrl(c)}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  title={c.url ? "Open the MLS listing" : "Search Zillow for this address"}
                  className="absolute bottom-1 left-10 text-[10px] font-semibold text-blue-700 underline-offset-2 opacity-0 transition-opacity hover:underline focus:opacity-100 group-hover:opacity-100"
                >
                  {c.url ? "Open listing ↗" : "See it on Zillow ↗"}
                </a>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* The hover card. Sits left of the list, anchored to the row, clamped so
          a row near the bottom of a scrolled list still shows a whole card. */}
      {preview && layers.candidates && <CandidateCard key={preview.c.property_id} c={preview.c} top={preview.top} />}

      <div className="absolute bottom-4 left-3 z-[1200] w-[236px] rounded-lg bg-white/95 p-3 text-xs shadow-lg backdrop-blur">
        <div className="mb-1.5 font-bold text-navy">Layers</div>
        {([["candidates", `Top 25 candidates${candidates.length ? ` (${candidates.length})` : ""}`], ["blocked", `Blocked by proximity${blocked.length ? ` (${blocked.length})` : ""}`], ["permits", "Existing STRs"], ["exclusion", "600-ft regulatory buffers"], ["parcels", "Fayette parcels (zoom 16+)"], ["zoning", "Lexington zoning (zoom 13+)"], ["boundary", "County boundary"]] as const).map(([k, label]) => (
          <label key={k} className="mb-1 flex cursor-pointer items-center gap-2"><input type="checkbox" checked={layers[k]} onChange={(e) => setLayers((s) => ({ ...s, [k]: e.target.checked }))} />{label}</label>
        ))}
        <div className="mt-2 border-t pt-2 text-[10px] text-slate-500">{pc.total} permits · {pc.blocking} blocking · {pc.hosted} hosted{pc.unlocated ? ` · ${pc.unlocated} awaiting geocode` : ""}{data.exclusionMeta ? ` · buffers ${data.exclusionMeta.rulesVersion}` : " · no buffers yet (import permits)"}</div>
        <div className="mt-1 text-[10px] text-slate-400">{candidates.length ? `${candidates.length} ranked candidates — numbered gold pins${spacingFt ? ` ringed in green by their ${spacingFt}-ft separation radius. Every ranked candidate passes separation; the ${blocked.length} that fail are on the yellow layer, gated out of the ranking.` : "."}` : "No ranked candidates yet — import listings, run forecasts, then re-rank."}</div>
      </div>

      {probe && (
        <div className="absolute left-14 top-16 z-[1250] w-[330px] rounded-xl bg-white p-4 text-sm shadow-2xl">
          <div className="mb-2 flex items-center justify-between"><b className="text-navy">Parcel probe</b><button onClick={() => { setProbe(null); setHl(null); }} className="rounded-full bg-slate-100 px-2 text-xs">×</button></div>
          {probe.loading ? <div className="text-slate-500">Looking up parcel &amp; zoning…</div> : probe.error ? <div className="text-red-700">{probe.error}</div> : (
            <div className="space-y-1.5">
              <div><span className="text-slate-500">Parcel:</span> {probe.parcel?.address ?? <i>none at this point</i>}</div>
              {probe.parcel?.acreage != null && <div><span className="text-slate-500">Acreage:</span> {Number(probe.parcel.acreage).toFixed(2)}</div>}
              <div className="flex items-center gap-2"><span className="text-slate-500">Zoning:</span> <Badge tone="info">{probe.zoning?.zone_code ?? "REQUIRES REVIEW"}</Badge>
                {probe.zoning?.treatment && <Badge tone={probe.zoning.treatment.includes("prohibit") ? "fail" : probe.zoning.treatment.includes("conditional") || probe.zoning.treatment === "review" ? "review" : "pass"}>{probe.zoning.treatment.replace(/_/g, " ")}</Badge>}</div>
              {probe.zoning?.ordinance_url && <a className="text-xs text-blue-600 underline" href={probe.zoning.ordinance_url} target="_blank" rel="noopener">Ordinance text →</a>}
              <div className="pt-1 text-[10px] text-slate-400">Source: {probe.source} · {new Date(probe.fetched_at).toLocaleTimeString()} · Spacing/density tests arrive in Phase 3</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Formatting helpers kept beside the card that uses them. */
const money = (n: number | null | undefined) => n == null ? "—" : "$" + Math.round(Number(n)).toLocaleString();
const acres = (sqft: number | null | undefined) => sqft == null ? null : (Number(sqft) / 43560).toFixed(2) + " ac";

/**
 * What the house is, without leaving the map.
 *
 * The photo is the one thing the ImagineMLS export does not carry: its export
 * view has no image field, so `primary_photo` is null on every row. Rather than
 * render a broken frame or a fake placeholder house, the slot says so and points
 * at Zillow, which is where the pictures actually are. If a photo URL ever
 * arrives — a re-cut export, or the RESO adapter — the image appears with no
 * further change.
 */
function CandidateCard({ c, top }: { c: CandidatePin; top: number }) {
  const [noImage, setNoImage] = useState(false);
  // The feed's own photo when it has one, else Street View. That route 404s
  // until a key is configured, which trips onError and leaves the note.
  const photo = c.primary_photo ?? `/api/streetview?lat=${c.lat}&lng=${c.lng}`;
  const CARD = 296;
  const clamped = Math.max(12, Math.min(top, (typeof window === "undefined" ? 900 : window.innerHeight) - CARD - 12));
  const yieldPct = c.gross_yield_pct == null ? null : Number(c.gross_yield_pct);
  const ppsf = c.price_per_sqft != null ? Number(c.price_per_sqft)
    : c.list_price != null && c.sqft ? Number(c.list_price) / Number(c.sqft) : null;

  return (
    <div
      style={{ top: clamped, right: 332 }}
      className="pointer-events-none fixed z-[1300] w-[264px] overflow-hidden rounded-xl bg-white shadow-2xl ring-1 ring-slate-200"
    >
      {!noImage && (
        <div className="h-[128px] bg-slate-100">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={photo}
            alt={c.address ?? "listing"}
            referrerPolicy="no-referrer"
            onError={() => setNoImage(true)}
            className="h-full w-full object-cover"
          />
        </div>
      )}

      <div className="p-3">
        <div className="truncate text-xs font-bold text-navy">{c.address ?? "—"}</div>
        <div className="mb-2 text-[10px] text-slate-400">
          {c.external_id ? `MLS ${c.external_id}` : ""}{c.zip ? ` · ${c.zip}` : ""}
          {c.days_on_market != null ? ` · ${c.days_on_market} days on market` : ""}
        </div>

        <div className="mb-2 flex items-baseline gap-2">
          <span className="text-sm font-bold text-navy">{money(c.list_price)}</span>
          {ppsf != null && <span className="text-[10px] text-slate-500">${Math.round(ppsf)}/sqft</span>}
        </div>

        <div className="mb-2 grid grid-cols-3 gap-1 rounded-lg bg-slate-50 p-1.5 text-center">
          {([[c.beds, "bed"], [c.baths, "bath"], [c.sqft == null ? null : Number(c.sqft).toLocaleString(), "sqft"]] as const).map(([v, label]) => (
            <div key={label}>
              <div className="text-xs font-bold text-navy">{v ?? "—"}</div>
              <div className="text-[9px] uppercase tracking-wide text-slate-400">{label}</div>
            </div>
          ))}
        </div>

        <div className="space-y-0.5 text-[10px] text-slate-600">
          {(c.year_built || c.lot_sqft) && (
            <div>
              {c.year_built ? `Built ${c.year_built}` : ""}
              {c.year_built && c.lot_sqft ? " · " : ""}
              {acres(c.lot_sqft) ?? ""}
              {c.property_type ? ` · ${c.property_type}` : ""}
            </div>
          )}
          <div>
            Est. revenue <b className="text-navy">{money(c.forecast_revenue)}</b>/yr
            {yieldPct != null && <> · <b className={yieldPct >= 20 ? "text-green-700" : "text-navy"}>{yieldPct.toFixed(1)}%</b> gross yield</>}
          </div>
          <div className="text-slate-500">
            Separation {c.spacing_result ?? "not tested"}
            {c.nearest_str_distance_ft != null ? ` · nearest STR ${Math.round(Number(c.nearest_str_distance_ft))} ft` : ""}
          </div>
          {c.hoa_status && <div className="text-slate-500">{c.hoa_status.replace("HOA_", "HOA ")}</div>}
          {noImage && (
            <div className="mt-1 border-t border-slate-100 pt-1 text-slate-400">
              No photo available &mdash; use the Zillow link on the row.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
