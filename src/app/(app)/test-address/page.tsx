"use client";
import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import PageHeader from "@/components/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Badge, classificationTone } from "@/components/ui/badge";
import { treatmentLabel } from "@/lib/rules";
import { factLabel } from "@/lib/eligibility";
import type { HoaStatus } from "@/lib/types";
const MapView = dynamic(() => import("@/components/MapView"), { ssr: false });

const HOA_OPTIONS: { value: HoaStatus; label: string }[] = [
  { value: "HOA_UNKNOWN", label: "Unverified" },
  { value: "VERIFIED_NO_HOA", label: "Verified: no HOA" },
  { value: "HOA_PRESENT", label: "HOA present" },
];

export default function TestAddress() {
  const [q, setQ] = useState(""); const [res, setRes] = useState<any[]>([]); const [pick, setPick] = useState<any>(null);
  const [hoa, setHoa] = useState<HoaStatus>("HOA_UNKNOWN");
  const [out, setOut] = useState<any>(null); const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (q.trim().length < 3) return setRes([]);
    const t = setTimeout(async () => { const j = await (await fetch(`/api/search?q=${encodeURIComponent(q)}`)).json(); setRes(j.results ?? []); }, 300);
    return () => clearTimeout(t);
  }, [q]);

  async function run(r: any, hoaStatus: HoaStatus = hoa) {
    setPick(r); setRes([]); setQ(r.address); setBusy(true); setOut(null);
    const j = await (await fetch(`/api/eligibility/check?lat=${r.lat}&lng=${r.lng}&hoa=${hoaStatus}`)).json();
    setOut(j); setBusy(false);
  }

  const parcel = out?.parcel;
  const facts = out?.facts;
  const elig = out?.eligibility;
  const t = treatmentLabel(facts?.zoning_treatment ?? null);
  const spacing = factLabel(facts?.spacing_result ?? null);
  const density = factLabel(facts?.density_result ?? null);
  const fails = (elig?.failures ?? []).filter((f: any) => f.severity === "fail");
  const reviews = (elig?.failures ?? []).filter((f: any) => f.severity === "review");

  return (
    <>
      <PageHeader
        title="Test Any Address"
        subtitle="Works for off-market homes too. Geocode → parcel → zoning → 600-ft separation → density → classification."
      />
      <div className="grid gap-4 p-6 lg:grid-cols-[440px_1fr]">
        <div className="space-y-4">
          <Card><CardBody>
            <label className="text-xs font-semibold text-slate-600">Address</label>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="123 Main Street" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            {res.length > 0 && (
              <div className="mt-1 max-h-56 overflow-auto rounded-lg border bg-white">
                {res.map((r) => <div key={r.address} onClick={() => run(r)} className="cursor-pointer border-b px-3 py-2 text-xs last:border-0 hover:bg-slate-50">{r.address}</div>)}
              </div>
            )}
            <div className="mt-3">
              <label className="text-xs font-semibold text-slate-600">HOA status</label>
              <select
                value={hoa}
                onChange={(e) => { const v = e.target.value as HoaStatus; setHoa(v); if (pick) run(pick, v); }}
                className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
              >
                {HOA_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <p className="mt-1 text-[11px] text-slate-500">A $0 fee in a listing is not proof of no HOA — set this only from a deed search or agent confirmation.</p>
            </div>
          </CardBody></Card>

          {(busy || out) && (
            <Card>
              <CardHeader
                title="Lexington STR Screening"
                subtitle={pick?.address}
                right={elig ? <Badge tone={classificationTone(elig.classification)}>{elig.classification}</Badge> : <Badge tone="review">…</Badge>}
              />
              <CardBody className="space-y-3 text-sm">
                {busy ? <div className="text-slate-500">Resolving parcel, zoning, and separation…</div>
                : out.error ? <div className="text-red-700">{out.error}</div> : (<>
                  <p className="rounded-lg bg-slate-50 p-3 text-xs leading-relaxed text-slate-700">{elig?.summary}</p>

                  <Row k="Parcel match" v={parcel?.found ? <Badge tone="pass">MATCHED</Badge> : <Badge tone="review">NOT FOUND</Badge>} />
                  <Row k="Parcel" v={parcel?.parcel?.address ?? "—"} />
                  {parcel?.parcel?.acreage != null && <Row k="Acreage" v={Number(parcel.parcel.acreage).toFixed(2)} />}
                  <Row k="Zoning" v={facts?.zone_code ? <Badge tone="info">{facts.zone_code}</Badge> : <Badge tone="review">NOT FOUND</Badge>} />
                  <Row k="Un-hosted STR treatment" v={<Badge tone={t.tone}>{t.label}</Badge>} />
                  <Row
                    k={`${facts?.spacing_ft ? Number(facts.spacing_ft).toLocaleString() : "600"}-ft separation`}
                    v={<Badge tone={spacing.tone}>{spacing.label}</Badge>}
                  />
                  {facts?.nearest_distance_ft != null && (
                    <Row k="Nearest blocking STR" v={
                      <span className="text-xs">
                        {Number(facts.nearest_distance_ft).toLocaleString()} ft
                        <span className="ml-1 text-slate-400">
                          ({facts.spacing_measured === "parcel_edge" ? "property line" : "permit point"})
                        </span>
                        {out.facts?.nearest_address && <div className="text-slate-500">{out.facts.nearest_address}</div>}
                      </span>
                    } />
                  )}
                  <Row k="Density" v={<Badge tone={density.tone}>{density.label}</Badge>} />
                  <Row k="HOA" v={<Badge tone={hoa === "VERIFIED_NO_HOA" ? "pass" : hoa === "HOA_PRESENT" ? "fail" : "review"}>{hoa}</Badge>} />
                  <Row k="Conditional use permit" v={<span className="text-xs">{elig?.cupRequired?.replace(/_/g, " ").toLowerCase()}</span>} />

                  {fails.length > 0 && (
                    <div className="rounded-lg border border-red-200 bg-red-50 p-3">
                      <div className="mb-1 text-[11px] font-bold uppercase tracking-wide text-red-800">Blocking</div>
                      {fails.map((f: any) => <div key={f.code} className="mb-1 text-xs leading-snug text-red-900 last:mb-0">{f.message}</div>)}
                    </div>
                  )}
                  {reviews.length > 0 && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                      <div className="mb-1 text-[11px] font-bold uppercase tracking-wide text-amber-900">Needs verification</div>
                      {reviews.map((f: any) => <div key={f.code} className="mb-1 text-xs leading-snug text-amber-900 last:mb-0">{f.message}</div>)}
                    </div>
                  )}

                  <div className="pt-1 text-[11px] text-slate-500">
                    Rules {out.rulesVersion ?? "—"} · measured from the {parcel?.found ? "parcel boundary" : "geocoded point"} ·
                    source {parcel?.source} · {new Date(out.checkedAt).toLocaleString()}
                  </div>
                  <div className="text-[11px] text-slate-500">Final determination: LFUCG Planning confirmation required.</div>
                  {facts?.zone_ordinance_url && <a href={facts.zone_ordinance_url} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 underline">Read the zoning ordinance text →</a>}
                </>)}
              </CardBody>
            </Card>
          )}
        </div>

        <Card className="min-h-[520px] overflow-hidden"><div className="h-[560px]">
          <MapView
            center={pick ? [pick.lat, pick.lng] : [38.035, -84.5]} zoom={pick ? 18 : 12}
            jurisdictionId="lfucg" permits={[]} exclusion={null}
            layers={{ exclusion: true, permits: true, candidates: false, blocked: false, parcels: true, zoning: true, boundary: false }}
            flyTo={pick ? { lat: pick.lat, lng: pick.lng, zoom: 18, nonce: Date.now() } : null}
            highlight={parcel?.parcel?.geometry ?? null}
          />
        </div></Card>
      </div>
    </>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="flex items-start justify-between gap-3 border-b border-slate-100 pb-2 last:border-0"><span className="shrink-0 text-slate-500">{k}</span><span className="text-right font-medium">{v}</span></div>;
}
