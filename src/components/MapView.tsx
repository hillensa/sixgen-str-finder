"use client";
import { useEffect, useRef } from "react";

export type PermitPin = { id: number; address_norm: string | null; address_raw: string | null; str_type: string | null; is_blocking: boolean | null; lat: number; lng: number; source: string | null };
export type Layers = { exclusion: boolean; permits: boolean; parcels: boolean; zoning: boolean; boundary: boolean };
type Props = {
  center: [number, number]; zoom: number; jurisdictionId: string;
  permits: PermitPin[]; exclusion: any | null; layers: Layers;
  flyTo?: { lat: number; lng: number; zoom?: number; nonce: number } | null;
  onMapClick?: (lat: number, lng: number) => void;
  highlight?: any | null; // GeoJSON geometry to outline (e.g., selected parcel)
};

const zoneColor = (z: string) => /^R-1|^R-2$|^R-3$|^R-4$|^R-5$|^R-1T|^EAR/.test(z || "") ? "#2d6a4f" : /^B-|^MU|^CN|^CC|^CD/.test(z || "") ? "#9d0208" : /^A-/.test(z || "") ? "#b08968" : "#5e548e";

export default function MapView({ center, zoom, jurisdictionId, permits, exclusion, layers, flyTo, onMapClick, highlight }: Props) {
  const el = useRef<HTMLDivElement>(null); const map = useRef<any>(null); const L = useRef<any>(null);
  const g = useRef<Record<string, any>>({}); const clickRef = useRef(onMapClick);
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
      for (const k of ["exclusion", "zoning", "parcels", "boundary", "highlight", "permits"]) g.current[k] = leaflet.layerGroup().addTo(m);
      m.on("click", (e: any) => clickRef.current?.(e.latlng.lat, e.latlng.lng));
    })();
    return () => { dead = true; if (map.current) { map.current.remove(); map.current = null; } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { const l = L.current, grp = g.current.exclusion; if (!l || !grp) return; grp.clearLayers();
    if (exclusion && layers.exclusion) l.geoJSON(exclusion, { pane: "exclusion", interactive: false, style: { color: "#c1121f", weight: 1, fillColor: "#c1121f", fillOpacity: 1 } }).addTo(grp);
  }, [exclusion, layers.exclusion]);

  useEffect(() => { const l = L.current, grp = g.current.permits; if (!l || !grp) return; grp.clearLayers(); if (!layers.permits) return;
    for (const p of permits) l.circleMarker([p.lat, p.lng], { pane: "pins", radius: 5, color: "#fff", weight: 1.5, fillColor: p.is_blocking ? "#14213d" : "#6b7280", fillOpacity: 1 })
      .bindTooltip(`<b>${p.address_norm ?? p.address_raw}</b><br>${p.str_type ?? "type unknown"} · ${p.is_blocking ? "counts toward spacing" : "not blocking"}`, { direction: "top", offset: [0, -6] })
      .bindPopup(`<b>${p.address_norm ?? p.address_raw}</b><br>Existing STR permit<br>Type: ${p.str_type ?? "unknown"}<br>Blocking: ${p.is_blocking ? "yes" : "no"}<br><small>Source: ${p.source}</small>`).addTo(grp);
  }, [permits, layers.permits]);

  useEffect(() => { const l = L.current, grp = g.current.highlight; if (!l || !grp) return; grp.clearLayers();
    if (highlight) l.geoJSON(highlight, { pane: "highlight", style: { color: "#00b4d8", weight: 3, fillColor: "#00b4d8", fillOpacity: 0.15 } }).addTo(grp);
  }, [highlight]);

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
  }, [layers.parcels, layers.zoning, layers.boundary, jurisdictionId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (flyTo && map.current) map.current.flyTo([flyTo.lat, flyTo.lng], flyTo.zoom ?? 17); }, [flyTo]);
  return <div ref={el} className="h-full w-full" />;
}
