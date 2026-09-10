"use client";
import { useEffect, useRef, useState } from "react";

export type PermitPin = { id: number; address_norm: string | null; address_raw: string | null; str_type: string | null; is_blocking: boolean | null; lat: number; lng: number; source: string | null };
/**
 * A ranked acquisition candidate. Deliberately a separate pin type from
 * PermitPin: a permit is a constraint that already exists, a candidate is a
 * house you might buy. Drawing them alike would invite reading a competitor as
 * an opportunity.
 */
export type CandidatePin = {
  property_id: number; address: string | null; lat: number; lng: number;
  score: number | null; rank: number | null; list_price: number | null;
  beds: number | null; forecast_revenue: number | null; gross_yield_pct: number | null;
  classification: string | null; hoa_status: string | null;
  url?: string | null; external_id?: string | null; zip?: string | null;
  spacing_result?: string | null; nearest_str_distance_ft?: number | null;
};
export type Layers = { exclusion: boolean; permits: boolean; candidates: boolean; blocked: boolean; parcels: boolean; zoning: boolean; boundary: boolean };
type Props = {
  center: [number, number]; zoom: number; jurisdictionId: string;
  permits: PermitPin[]; candidates?: CandidatePin[]; hoveredCandidate?: number | null;
  /**
   * Listings the separation rule rules out. They are never in `candidates` —
   * eligibility gates before scoring, so a failing house cannot be ranked — and
   * without their own layer the "too close to an existing STR" case would be
   * invisible on a map that only ever draws the Top 25.
   */
  blocked?: CandidatePin[];
  /** Separation radius in feet, read from str_rules rather than assumed. */
  spacingFt?: number | null;
  exclusion: any | null; layers: Layers;
  flyTo?: { lat: number; lng: number; zoom?: number; nonce: number } | null;
  onMapClick?: (lat: number, lng: number) => void;
  highlight?: any | null; // GeoJSON geometry to outline (e.g., selected parcel)
};

const zoneColor = (z: string) => /^R-1|^R-2$|^R-3$|^R-4$|^R-5$|^R-1T|^EAR/.test(z || "") ? "#2d6a4f" : /^B-|^MU|^CN|^CC|^CD/.test(z || "") ? "#9d0208" : /^A-/.test(z || "") ? "#b08968" : "#5e548e";

export default function MapView({ center, zoom, jurisdictionId, permits, candidates = [], blocked = [], hoveredCandidate = null, spacingFt = null, exclusion, layers, flyTo, onMapClick, highlight }: Props) {
  const el = useRef<HTMLDivElement>(null); const map = useRef<any>(null); const L = useRef<any>(null);
  const g = useRef<Record<string, any>>({}); const clickRef = useRef(onMapClick);
  // Leaflet is imported dynamically, so the map may not exist when the data
  // arrives. Every layer effect below bails out when it does not, and nothing
  // re-ran them once it appeared: locally Leaflet was warm and won the race, in
  // production its chunk is a cold fetch while /api/market is fast, so the
  // permits arrived first and no pin was ever drawn. This flips when the panes
  // and layer groups exist, and every effect depends on it.
  const markers = useRef<Record<number, { marker: any; rank: number; tone: string }>>({});
  const hoveredRef = useRef<number | null>(null);
  const [ready, setReady] = useState(false);
  clickRef.current = onMapClick;

  useEffect(() => {
    let dead = false;
    (async () => {
      const leaflet = (await import("leaflet")).default;
      if (dead || !el.current || map.current) return;
      L.current = leaflet;
      const m = leaflet.map(el.current, { center, zoom, preferCanvas: true }); map.current = m;
      leaflet.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap" }).addTo(m);
      const mk = (n: string, z: number, o?: string, pe?: string) => { const p = m.createPane(n); p.style.zIndex = String(z); if (o) p.style.opacity = o; if (pe) p.style.pointerEvents = pe; };
      mk("exclusion", 350, "0.42", "none"); mk("zoning", 360, "0.35"); mk("parcels", 380); mk("boundary", 390, undefined, "none"); mk("highlight", 440, undefined, "none"); mk("pins", 460);
      for (const k of ["exclusion", "zoning", "parcels", "boundary", "highlight", "permits", "blocked", "candidates"]) g.current[k] = leaflet.layerGroup().addTo(m);
      m.on("click", (e: any) => clickRef.current?.(e.latlng.lat, e.latlng.lng));
      if (!dead) setReady(true);
    })();
    return () => { dead = true; setReady(false); if (map.current) { map.current.remove(); map.current = null; } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { const l = L.current, grp = g.current.exclusion; if (!l || !grp) return; grp.clearLayers();
    if (exclusion && layers.exclusion) l.geoJSON(exclusion, { pane: "exclusion", interactive: false, style: { color: "#c1121f", weight: 1, fillColor: "#c1121f", fillOpacity: 1 } }).addTo(grp);
  }, [ready, exclusion, layers.exclusion]);

  useEffect(() => { const l = L.current, grp = g.current.permits; if (!l || !grp) return; grp.clearLayers(); if (!layers.permits) return;
    for (const p of permits) l.circleMarker([p.lat, p.lng], { pane: "pins", radius: 5, color: "#fff", weight: 1.5, fillColor: p.is_blocking ? "#14213d" : "#6b7280", fillOpacity: 1 })
      .bindTooltip(`<b>${p.address_norm ?? p.address_raw}</b><br>${p.str_type ?? "type unknown"} · ${p.is_blocking ? "counts toward spacing" : "not blocking"}`, { direction: "top", offset: [0, -6] })
      .bindPopup(`<b>${p.address_norm ?? p.address_raw}</b><br>Existing STR permit<br>Type: ${p.str_type ?? "unknown"}<br>Blocking: ${p.is_blocking ? "yes" : "no"}<br><small>Source: ${p.source}</small>`).addTo(grp);
  }, [ready, permits, layers.permits]);

  /** One icon builder for both the initial draw and the hover resize. */
  const candidateIcon = (l: any, rank: number, tone: string, big: boolean) => {
    const d = big ? 34 : 24;
    return l.divIcon({
      className: "",
      html: `<div style="display:flex;align-items:center;justify-content:center;width:${d}px;height:${d}px;border-radius:50%;background:#c9a227;color:#14213d;font:700 ${big ? 14 : 11}px/1 system-ui;border:${big ? 3 : 2}px solid ${tone};box-shadow:0 ${big ? 3 : 1}px ${big ? 10 : 4}px rgba(0,0,0,.45);transition:all .12s">${rank}</div>`,
      iconSize: [d, d], iconAnchor: [d / 2, d / 2],
    });
  };

  // Candidates sit above permits and look nothing like them: a numbered gold
  // marker rather than a small dot. The number is the rank, so the map answers
  // "where is #1" without cross-referencing the table.
  useEffect(() => { const l = L.current, grp = g.current.candidates; if (!l || !grp) return; grp.clearLayers(); markers.current = {}; if (!layers.candidates) return;
    const money = (n: number | null) => n == null ? "—" : "$" + Math.round(n).toLocaleString();
    candidates.forEach((c, i) => {
      if (c.lat == null || c.lng == null) return;
      const rank = c.rank ?? i + 1;
      const tone = c.classification === "GREEN" ? "#15803d" : c.classification === "RED" ? "#b91c1c" : "#b45309";
      // The property's own separation radius.
      //
      // Filled by the STORED spacing result, not by a browser-side overlap
      // test. PostGIS measures from the parcel boundary where one is matched
      // and reports PASS / FAIL / REVIEW; re-deciding it here from circle
      // geometry would be an approximation that could disagree with the
      // screening, which is the one thing the map must never do.
      //
      // Note what the circle does and does not mean: it is 600 ft around THIS
      // house. Two such circles overlapping puts the houses within 1200 ft,
      // which is not a violation. The fill is the answer; the circle is the
      // scale.
      if (spacingFt && spacingFt > 0) {
        const sr = (c.spacing_result ?? "").toUpperCase();
        const fill = sr === "PASS" ? "#15803d" : sr === "FAIL" || sr === "REVIEW" ? "#eab308" : "#94a3b8";
        l.circle([c.lat, c.lng], {
          pane: "pins",
          radius: spacingFt * 0.3048,          // feet -> metres
          color: fill, weight: 1.5,
          dashArray: sr === "REVIEW" ? "4 3" : undefined,   // measured from a point, not a boundary
          fillColor: fill,
          fillOpacity: sr === "PASS" ? 0.18 : sr ? 0.28 : 0.10,
        }).addTo(grp);
      }

      const marker = l.marker([c.lat, c.lng], {
        pane: "pins", zIndexOffset: 1000,
        icon: candidateIcon(l, rank, tone, c.property_id === hoveredRef.current),
      }).bindPopup(
        `<b>#${rank} &middot; ${c.address ?? "—"}</b><br>` +
        `${money(c.list_price)}${c.beds ? ` &middot; ${c.beds} bd` : ""}<br>` +
        `Forecast ${money(c.forecast_revenue)}${c.gross_yield_pct != null ? ` &middot; ${Number(c.gross_yield_pct).toFixed(1)}% yield` : ""}<br>` +
        `Score ${c.score == null ? "—" : Number(c.score).toFixed(1)} &middot; ${c.classification ?? "—"}<br>` +
        `Separation: ${c.spacing_result ?? "not tested"}` +
        `${c.nearest_str_distance_ft != null ? ` &middot; nearest STR ${Math.round(Number(c.nearest_str_distance_ft))} ft` : ""}<br>` +
        `<small>${(c.hoa_status ?? "").replace("HOA_", "HOA ") || ""}</small><br>` +
        `<a href="/property/${c.property_id}">Open property &rarr;</a>`
      ).addTo(grp);
      markers.current[c.property_id] = { marker, rank, tone };
    });
  }, [ready, candidates, layers.candidates, spacingFt]);

  // Listings the separation rule blocks. Same circle, yellow fill, and a hollow
  // marker rather than a numbered one — they have no rank because they never
  // reached the ranking. Drawn beneath the candidates so a blocked house can
  // never be mistaken for one you can buy.
  useEffect(() => { const l = L.current, grp = g.current.blocked; if (!l || !grp) return; grp.clearLayers(); if (!layers.blocked) return;
    const money = (n: number | null) => n == null ? "—" : "$" + Math.round(n).toLocaleString();
    blocked.forEach((c) => {
      if (c.lat == null || c.lng == null) return;
      if (spacingFt && spacingFt > 0) {
        l.circle([c.lat, c.lng], {
          pane: "pins", radius: spacingFt * 0.3048,
          color: "#eab308", weight: 1.5, fillColor: "#eab308", fillOpacity: 0.28,
        }).addTo(grp);
      }
      l.circleMarker([c.lat, c.lng], {
        pane: "pins", radius: 5, color: "#a16207", weight: 2, fillColor: "#fde047", fillOpacity: 1,
      }).bindPopup(
        `<b>${c.address ?? "—"}</b><br>` +
        `${money(c.list_price)}${c.beds ? ` &middot; ${c.beds} bd` : ""}<br>` +
        `<b>Blocked: too close to an existing STR</b><br>` +
        `${c.nearest_str_distance_ft != null ? `Nearest STR ${Math.round(Number(c.nearest_str_distance_ft))} ft away` : "Nearest STR distance not recorded"}` +
        `${spacingFt ? ` &middot; rule requires ${spacingFt} ft` : ""}<br>` +
        // A near-zero separation means the nearest permit is on this parcel or
        // the one touching it — which can mean the house being sold is ITSELF a
        // permitted STR. That is the opposite of a disqualification, but whether
        // the permit survives a sale is an LFUCG question, so flag it for a
        // human instead of deciding it here.
        `${c.nearest_str_distance_ft != null && Number(c.nearest_str_distance_ft) < 30
            ? `<i>The nearest permit is on or adjoining this parcel &mdash; check whether this listing is itself a permitted STR.</i><br>` : ""}` +
        `<a href="/property/${c.property_id}">Open property &rarr;</a>`
      ).addTo(grp);
    });
  }, [ready, blocked, layers.blocked, spacingFt]);

  // Hovering a row in the Top 25 list grows its pin. Done by swapping the icon
  // on the existing marker rather than redrawing the layer, so an open popup
  // survives and the map does not flicker on every mouse move.
  useEffect(() => {
    // Record the hover first: a row hovered while the Leaflet chunk is still
    // downloading would otherwise be forgotten, and the pin would draw small.
    hoveredRef.current = hoveredCandidate;
    const l = L.current; if (!l) return;
    for (const [id, m] of Object.entries(markers.current)) {
      const on = Number(id) === hoveredCandidate;
      m.marker.setIcon(candidateIcon(l, m.rank, m.tone, on));
      m.marker.setZIndexOffset(on ? 2000 : 1000);
    }
  }, [ready, hoveredCandidate, candidates, layers.candidates]);

  useEffect(() => { const l = L.current, grp = g.current.highlight; if (!l || !grp) return; grp.clearLayers();
    if (highlight) l.geoJSON(highlight, { pane: "highlight", style: { color: "#00b4d8", weight: 3, fillColor: "#00b4d8", fillOpacity: 0.15 } }).addTo(grp);
  }, [ready, highlight]);

  // viewport-scoped overlays
  useEffect(() => {
    const l = L.current, m = map.current; if (!l || !m) return;
    const cfg: [keyof Layers, string, number, (f: any) => any, ((f: any, lyr: any) => void) | undefined][] = [
      ["parcels", "parcels", 16, () => ({ color: "#7d8597", weight: 1, fill: true, fillOpacity: 0.02 }), (f, lyr) => lyr.bindPopup(`<b>Parcel:</b> ${f.properties?.ADDRESS ?? "—"}`)],
      ["zoning", "zoning", 13, (f) => ({ color: zoneColor(f.properties?.ZONING), weight: 1, fillColor: zoneColor(f.properties?.ZONING), fillOpacity: 0.25 }), (f, lyr) => lyr.bindPopup(`<b>Zoning: ${f.properties?.ZONING ?? "?"}</b>${f.properties?.LINK ? `<br><a href="${f.properties.LINK}" target="_blank" rel="noopener">Ordinance text →</a>` : ""}`)],
      ["boundary", "boundary", 0, () => ({ color: "#14213d", weight: 2.5, fill: false, dashArray: "6 4" }), undefined],
    ];
    const loaders = cfg.map(([key, pane, minZoom, style, each]) => {
      const grp = g.current[key];
      const load = async () => {
        if (!layers[key]) { grp.clearLayers(); return; }
        if (m.getZoom() < minZoom) { grp.clearLayers(); return; }
        const b = m.getBounds(); const bbox = key === "boundary" ? "" : `&bbox=${encodeURIComponent([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].join(","))}`;
        try { const gj = await (await fetch(`/api/overlay?layer=${key}&jurisdiction=${jurisdictionId}${bbox}`)).json(); grp.clearLayers(); l.geoJSON(gj, { pane, style, onEachFeature: each }).addTo(grp); } catch { /* best effort */ }
      };
      load(); m.on("moveend", load); return load;
    });
    return () => { loaders.forEach((fn) => m.off("moveend", fn)); };
  }, [ready, layers.parcels, layers.zoning, layers.boundary, jurisdictionId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (flyTo && map.current) map.current.flyTo([flyTo.lat, flyTo.lng], flyTo.zoom ?? 17); }, [ready, flyTo]);
  return <div ref={el} className="h-full w-full" />;
}
