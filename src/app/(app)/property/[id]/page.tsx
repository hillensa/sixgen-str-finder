"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import dynamicImport from "next/dynamic";
import PageHeader from "@/components/PageHeader";
import { Card, CardBody, CardHeader, Stat } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge, classificationTone } from "@/components/ui/badge";
const MapView = dynamicImport(() => import("@/components/MapView"), { ssr: false });

const money = (n: any) => (n == null ? "—" : `$${Math.round(Number(n)).toLocaleString()}`);
const pct = (n: any) => (n == null ? "—" : `${Number(n).toFixed(1)}%`);
const occ = (n: any) => (n == null ? "—" : `${(Number(n) * 100).toFixed(1)}%`);

/** [assumption key, label, step, format] */
const INPUTS: [string, string, number, "money" | "pct" | "num"][] = [
  ["purchasePrice", "Purchase price", 5000, "money"],
  ["annualRevenue", "Annual revenue", 1000, "money"],
  ["managementPct", "Management", 0.01, "pct"],
  ["cleaningPerStay", "Cleaning per stay", 5, "money"],
  ["avgStayNights", "Average stay (nights)", 0.5, "num"],
  ["utilitiesMonthly", "Utilities / month", 10, "money"],
  ["internetMonthly", "Internet / month", 5, "money"],
  ["lawnSnowMonthly", "Lawn & snow / month", 10, "money"],
  ["suppliesPct", "Supplies", 0.005, "pct"],
  ["repairsPct", "Repairs", 0.005, "pct"],
  ["insuranceAnnual", "Insurance / year", 100, "money"],
  ["taxRatePct", "Property tax rate %", 0.05, "num"],
  ["hoaMonthly", "HOA / month", 10, "money"],
  ["furnishingPerBedroom", "Furnishing per bedroom", 500, "money"],
  ["closingCostPct", "Closing costs", 0.005, "pct"],
  ["downPaymentPct", "Down payment", 0.05, "pct"],
  ["interestRatePct", "Interest rate %", 0.125, "num"],
  ["loanYears", "Loan term (years)", 1, "num"],
];

export default function PropertyDetail({ params }: { params: { id: string } }) {
  const [d, setD] = useState<any>(null);
  const [a, setA] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    const j = await (await fetch(`/api/properties/${params.id}`)).json();
    setD(j.error ? { error: j.error } : j);
    if (!j.error) setA(j.assumptions);
  }, [params.id]);
  useEffect(() => { load(); }, [load]);

  async function post(body: any, label: string) {
    setBusy(label); setMsg(null);
    const j = await (await fetch(`/api/properties/${params.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
    setBusy(null);
    if (j.error) { setMsg(j.error); return null; }
    return j;
  }

  if (d?.error) return <><PageHeader title="Property" /><div className="p-6 text-sm text-red-700">{d.error}</div></>;
  if (!d) return <><PageHeader title="Property" /><div className="p-6 text-sm text-slate-500">Loading…</div></>;

  const c = d.candidate;
  const pf = d.proFormaResult;
  const elig = d.eligibility;
  const fails = (d.failures ?? []).filter((f: any) => f.severity === "fail");
  const reviews = (d.failures ?? []).filter((f: any) => f.severity === "review");

  return (
    <>
      <PageHeader
        title={c.address}
        subtitle={`${c.beds ?? "—"} bd · ${c.baths ?? "—"} ba · ${c.sqft?.toLocaleString() ?? "—"} sqft · ${money(c.list_price)}${c.zip ? ` · ${c.zip}` : ""}`}
        right={
          <div className="flex items-center gap-2">
            {c.classification && <Badge tone={classificationTone(c.classification)}>{c.classification}</Badge>}
            {d.score?.score != null && <Badge tone="gold">Score {Number(d.score.score).toFixed(1)}</Badge>}
            <Button variant={d.isSaved ? "secondary" : "primary"} onClick={async () => { const j = await post({ action: "save", saved: !d.isSaved }, "save"); if (j) setD({ ...d, isSaved: j.isSaved }); }} disabled={busy !== null}>
              {d.isSaved ? "Saved" : "Save"}
            </Button>
            <Link href="/top25" className="text-xs text-blue-600 underline">← Top 25</Link>
          </div>
        }
      />

      <div className="space-y-4 p-6">
        {msg && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{msg}</div>}

        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader title="Revenue forecast" subtitle={`${c.comp_count ?? 0} Sixgen comparables · ${c.model_version ?? "—"}`}
              right={c.forecast_confidence ? <Badge tone={c.forecast_confidence === "HIGH" ? "pass" : c.forecast_confidence === "MEDIUM" ? "review" : "fail"}>{c.forecast_confidence}</Badge> : null} />
            <CardBody>
              <div className="grid grid-cols-3 gap-4">
                {(d.forecasts ?? []).sort((x: any, y: any) => Number(x.annual_revenue) - Number(y.annual_revenue)).map((f: any) => (
                  <div key={f.scenario} className={`rounded-lg border p-3 ${f.scenario === "base" ? "border-navy bg-slate-50" : "border-slate-200"}`}>
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{f.scenario}</div>
                    <div className="mt-0.5 text-xl font-bold text-navy">{money(f.annual_revenue)}</div>
                    <div className="text-xs text-slate-500">{money(f.adr)} ADR · {occ(f.occupancy)}</div>
                  </div>
                ))}
              </div>
              {!d.forecasts?.length && <p className="text-sm text-slate-500">No forecast yet — run the Sixgen comparables from Admin.</p>}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Eligibility" subtitle={elig ? `Rules ${elig.rules_version} · ${new Date(elig.checked_at).toLocaleDateString()}` : "Not screened"} />
            <CardBody className="space-y-2 text-xs">
              <Row k="Zoning" v={c.zone_code ?? "—"} />
              <Row k="Treatment" v={String(c.zoning_treatment ?? "not set").replace(/_/g, " ")} />
              <Row k="Separation" v={`${c.spacing_result ?? "—"}${c.nearest_str_distance_ft ? ` · ${Math.round(c.nearest_str_distance_ft)} ft` : ""}`} />
              <Row k="Density" v={String(c.density_result ?? "—").replace(/_/g, " ")} />
              <Row k="HOA" v={String(c.hoa_status ?? "—").replace(/_/g, " ").toLowerCase()} />
              <Row k="CUP" v={String(c.cup_required ?? "—").replace(/_/g, " ").toLowerCase()} />
              {fails.map((f: any) => <div key={f.code} className="rounded border border-red-200 bg-red-50 p-2 text-red-900">{f.message}</div>)}
              {reviews.map((f: any) => <div key={f.code} className="rounded border border-amber-200 bg-amber-50 p-2 text-amber-900">{f.message}</div>)}
            </CardBody>
          </Card>
        </div>

        {/* ── pro forma ─────────────────────────────────────────────── */}
        {a && pf && (
          <div className="grid gap-4 lg:grid-cols-[380px_1fr]">
            <Card>
              <CardHeader title="Assumptions" subtitle="Every line is an input — nothing is hidden in a constant" />
              <CardBody className="space-y-2">
                <label className="flex items-center gap-2 text-xs text-slate-600">
                  <input type="checkbox" checked={a.financed} onChange={(e) => setA({ ...a, financed: e.target.checked })} />Financed
                </label>
                <div className="grid max-h-[420px] grid-cols-2 gap-2 overflow-auto pr-1">
                  {INPUTS.map(([k, label, step, fmt]) => (
                    <label key={k} className="block">
                      <div className="mb-0.5 text-[10px] font-semibold text-slate-500">{label}{fmt === "pct" ? " (0–1)" : ""}</div>
                      <input type="number" step={step} value={a[k] ?? 0}
                        onChange={(e) => setA({ ...a, [k]: Number(e.target.value) })}
                        className="w-full rounded border border-slate-300 px-1.5 py-1 text-xs" />
                    </label>
                  ))}
                </div>
                <Button className="w-full" disabled={busy !== null}
                  onClick={async () => { const j = await post({ action: "proforma", assumptions: a }, "pf"); if (j) { setD({ ...d, proFormaResult: j.results, amenityScenarios: j.amenityScenarios }); setMsg(null); } }}>
                  {busy === "pf" ? "Saving…" : "Recalculate & save"}
                </Button>
              </CardBody>
            </Card>

            <div className="space-y-4">
              <Card>
                <CardHeader title="Underwriting" subtitle={`${pf.version} · before tax treatment and depreciation`} />
                <CardBody>
                  <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
                    <Stat label="NOI" value={money(pf.noi)} tone={pf.noi > 0 ? "pass" : "fail"} />
                    <Stat label="Cap rate" value={pct(pf.capRatePct)} />
                    <Stat label="Cash flow" value={money(pf.cashFlow)} tone={pf.cashFlow > 0 ? "pass" : "fail"} hint="after debt service" />
                    <Stat label="Cash-on-cash" value={pct(pf.cashOnCashPct)} hint={`${money(pf.cashInvested)} in`} />
                    <Stat label="Break-even occ." value={pf.breakEvenOccupancy == null ? "—" : occ(pf.breakEvenOccupancy)} />
                  </div>
                  <table className="mt-4 w-full text-xs">
                    <tbody>
                      <tr className="border-b border-slate-200"><td className="py-1 font-medium">Revenue</td><td className="text-right font-medium">{money(pf.revenue)}</td><td className="pl-4 text-slate-400">forecast base case</td></tr>
                      {pf.expenses.map((e: any) => (
                        <tr key={e.key} className="border-b border-slate-100"><td className="py-1 text-slate-600">{e.label}</td><td className="text-right">({money(e.annual)})</td><td className="pl-4 text-slate-400">{e.basis}</td></tr>
                      ))}
                      <tr className="border-b-2 border-slate-300"><td className="py-1 font-medium">Net operating income</td><td className="text-right font-bold">{money(pf.noi)}</td><td className="pl-4 text-slate-400">{(pf.expenseRatio * 100).toFixed(0)}% expense ratio</td></tr>
                      {pf.annualDebtService > 0 && (
                        <tr className="border-b border-slate-100"><td className="py-1 text-slate-600">Debt service</td><td className="text-right">({money(pf.annualDebtService)})</td><td className="pl-4 text-slate-400">DSCR {pf.dscr ?? "—"}×</td></tr>
                      )}
                      <tr><td className="py-1 font-medium">Cash flow</td><td className="text-right font-bold">{money(pf.cashFlow)}</td><td /></tr>
                    </tbody>
                  </table>
                  {pf.warnings.map((w: string) => <div key={w} className="mt-2 rounded border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-900">{w}</div>)}
                </CardBody>
              </Card>

              <Card>
                <CardHeader title="Amenity upside" subtitle="Sorted by payback. Lifts are planning figures — revise them against real before/after data." />
                <CardBody className="px-0 py-0">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50 text-left text-slate-500"><tr><th className="px-4 py-2">Upgrade</th><th>Cost</th><th>Added revenue</th><th>New cash flow</th><th>Payback</th><th>Return</th></tr></thead>
                    <tbody>
                      {(d.amenityScenarios ?? []).map((sc: any) => (
                        <tr key={sc.upgrade.key} className="border-t border-slate-100 align-top">
                          <td className="px-4 py-2"><div className="font-medium">{sc.upgrade.label}</div><div className="text-[10px] text-slate-400">{sc.upgrade.note}</div></td>
                          <td>{money(sc.upgrade.cost)}</td>
                          <td className="text-green-700">+{money(sc.addedRevenue)}</td>
                          <td>{money(sc.newCashFlow)}</td>
                          <td className="font-medium">{sc.paybackYears == null ? "—" : `${sc.paybackYears} yr`}</td>
                          <td>{sc.incrementalReturnPct == null ? "—" : `${sc.incrementalReturnPct}%`}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </CardBody>
              </Card>
            </div>
          </div>
        )}

        {/* ── comps, map, pipeline ──────────────────────────────────── */}
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="Comparables" subtitle="Sixgen listings that produced this forecast" />
            <CardBody className="px-0 py-0">
              {!d.comps?.length ? <div className="p-6 text-sm text-slate-500">No comparables recorded.</div> : (
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 text-left text-slate-500"><tr><th className="px-4 py-2">Listing</th><th>Bd</th><th>ADR</th><th>Occ</th><th>T12</th><th>Weight</th></tr></thead>
                  <tbody>
                    {d.comps.map((cm: any) => (
                      <tr key={cm.name} className="border-t border-slate-100">
                        <td className="px-4 py-1.5"><div className="font-medium">{cm.name}</div><div className="text-[10px] text-slate-400">{(cm.reasons ?? []).join(" · ")}</div></td>
                        <td>{cm.beds}</td><td>{money(cm.adr)}</td><td>{occ(cm.occupancy)}</td><td>{money(cm.gross_revenue)}</td>
                        <td className="font-medium">{(Number(cm.weight) * 100).toFixed(0)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardBody>
          </Card>

          <Card className="overflow-hidden"><div className="h-[320px]">
            <MapView center={[c.lat ?? 38.035, c.lng ?? -84.5]} zoom={16} jurisdictionId="lfucg"
              permits={[]} exclusion={null}
              layers={{ exclusion: true, permits: true, candidates: false, blocked: false, parcels: true, zoning: false, boundary: false }}
              flyTo={c.lat ? { lat: c.lat, lng: c.lng, zoom: 16, nonce: c.property_id } : null} highlight={null} />
          </div></Card>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader title="Pipeline" subtitle="Where this sits in the acquisition process" />
            <CardBody className="space-y-2">
              <div className="flex flex-wrap gap-1.5">
                {(d.pipelineStatuses ?? []).map((st: string) => (
                  <button key={st} disabled={busy !== null}
                    onClick={async () => { const j = await post({ action: "pipeline", status: st, assignToMe: true }, "pl"); if (j) setD({ ...d, pipeline: j.pipeline }); }}
                    className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition ${d.pipeline?.status === st ? "bg-navy text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>
                    {st}
                  </button>
                ))}
              </div>
              {d.pipeline && (
                <div className="text-[11px] text-slate-500">
                  Last moved {new Date(d.pipeline.stage_changed_at ?? d.pipeline.updated_at).toLocaleString()}
                  {d.pipeline.offer_price ? ` · offer ${money(d.pipeline.offer_price)}` : ""}
                </div>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Notes" />
            <CardBody className="space-y-2">
              <div className="flex gap-2">
                <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What did you learn?" className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm" />
                <Button disabled={busy !== null || !note.trim()}
                  onClick={async () => { const j = await post({ action: "note", body: note }, "note"); if (j) { setNote(""); await load(); } }}>Add</Button>
              </div>
              <div className="max-h-40 space-y-1.5 overflow-auto">
                {(d.notes ?? []).map((n: any, i: number) => (
                  <div key={i} className="rounded border border-slate-100 bg-slate-50 p-2 text-xs">
                    <div>{n.body}</div>
                    <div className="mt-0.5 text-[10px] text-slate-400">{new Date(n.created_at).toLocaleString()}</div>
                  </div>
                ))}
                {!d.notes?.length && <p className="text-xs text-slate-500">No notes yet.</p>}
              </div>
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="flex items-center justify-between gap-2 border-b border-slate-100 pb-1 last:border-0"><span className="text-slate-500">{k}</span><span className="text-right font-medium">{v}</span></div>;
}
