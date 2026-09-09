"use client";
import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { Badge } from "@/components/ui/badge";
import type { Layers, PermitPin, CandidatePin } from "@/components/MapView";
const MapView = dynamic(() => import("@/components/MapView"), { ssr: false, loading: () => <div className="flex h-full items-center justify-center text-slate-400">Loading map…</div> });

export default function MapPage() {
  const [data, setData] = useState<any>(null); const [err, setErr] = useState<string | null>(null);
  const [layers, setLayers] = useState<Layers>({ exclusion: true, permits: true, candidates: true, parcels: false, zoning: false, boundary: true });
  const [flyTo, setFlyTo] = useState<any>(null); const [q, setQ] = useState(""); const [res, setRes] = useState<any[]>([]);
  const [probe, setProbe] = useState<any>(null); const [hl, setHl] = useState<any>(null);
  const [candidates, setCandidates] = useState<CandidatePin[]>([]);

  // Ranked candidates come from the same endpoint Top 25 renders, so the map and
  // the table can never disagree about who is #1.
  useEffect(() => {
    fetch("/api/scores?market=lexington-ky&limit=25")
      .then((r) => r.json())
      .then((j) => setCandidates((j.top ?? []).filter((c: any) => c.lat != null && c.lng != null)))
      .catch(() => setCandidates([]));
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
      <MapView center={[data.market.center_lat, data.market.center_lng]} zoom={data.market.default_zoom} jurisdictionId={data.jurisdiction?.id ?? "lfucg"} permits={permits} candidates={candidates} exclusion={data.exclusion} layers={layers} flyTo={flyTo} onMapClick={probeAt} highlight={hl} />

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
                <button
                  key={c.property_id}
                  onClick={() => { setFlyTo({ lat: c.lat, lng: c.lng, zoom: 17, nonce: Date.now() }); probeAt(c.lat, c.lng); }}
                  className="flex w-full items-start gap-2 border-b border-slate-100 px-3 py-2 text-left hover:bg-amber-50"
                >
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gold text-[10px] font-bold text-navy">{rank}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-semibold text-navy">{c.address ?? "—"}</span>
                    <span className="block text-[11px] text-slate-500">
                      {c.list_price != null ? `$${Math.round(c.list_price).toLocaleString()}` : "—"}
                      {c.beds ? ` · ${c.beds} bd` : ""}
                      {c.forecast_revenue != null ? ` · fc $${Math.round(Number(c.forecast_revenue) / 1000)}k` : ""}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className={`block text-xs font-bold ${yieldPct != null && yieldPct >= 20 ? "text-green-700" : "text-navy"}`}>
                      {yieldPct != null ? `${yieldPct.toFixed(1)}%` : "—"}
                    </span>
                    <Badge tone={tone as any}>{c.score == null ? "—" : Number(c.score).toFixed(0)}</Badge>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="absolute bottom-4 left-3 z-[1200] w-[236px] rounded-lg bg-white/95 p-3 text-xs shadow-lg backdrop-blur">
        <div className="mb-1.5 font-bold text-navy">Layers</div>
        {([["candidates", `Top 25 candidates${candidates.length ? ` (${candidates.length})` : ""}`], ["permits", "Existing STRs"], ["exclusion", "600-ft regulatory buffers"], ["parcels", "Fayette parcels (zoom 16+)"], ["zoning", "Lexington zoning (zoom 13+)"], ["boundary", "County boundary"]] as const).map(([k, label]) => (
          <label key={k} className="mb-1 flex cursor-pointer items-center gap-2"><input type="checkbox" checked={layers[k]} onChange={(e) => setLayers((s) => ({ ...s, [k]: e.target.checked }))} />{label}</label>
        ))}
        <div className="mt-2 border-t pt-2 text-[10px] text-slate-500">{pc.total} permits · {pc.blocking} blocking · {pc.hosted} hosted{pc.unlocated ? ` · ${pc.unlocated} awaiting geocode` : ""}{data.exclusionMeta ? ` · buffers ${data.exclusionMeta.rulesVersion}` : " · no buffers yet (import permits)"}</div>
        <div className="mt-1 text-[10px] text-slate-400">{candidates.length ? `${candidates.length} ranked candidates — numbered gold pins, ring colour is the eligibility class` : "No ranked candidates yet — import listings, run forecasts, then re-rank."}</div>
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
