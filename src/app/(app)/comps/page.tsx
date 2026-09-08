"use client";
import { useCallback, useEffect, useState } from "react";
import PageHeader from "@/components/PageHeader";
import { Card, CardBody, CardHeader, Stat } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

const money = (n: number | null | undefined) => (n == null ? "—" : `$${Math.round(Number(n)).toLocaleString()}`);
const pct = (n: number | null | undefined) => (n == null ? "—" : `${(Number(n) * 100).toFixed(1)}%`);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** [engine key, database column, label] — the engine is camelCase, the view is snake_case. */
const AMENITIES = [
  ["hotTub", "hot_tub", "Hot tub"], ["golfSim", "golf_sim", "Golf sim"], ["gameRoom", "game_room", "Game room"],
  ["pool", "pool", "Pool"], ["firePit", "fire_pit", "Fire pit"], ["poolTable", "pool_table", "Pool table"],
] as const;

const confidenceTone = (c: string) => (c === "HIGH" ? "pass" : c === "MEDIUM" ? "review" : "fail");

export default function SixgenComps() {
  const [portfolio, setPortfolio] = useState<any>(null);
  const [t12, setT12] = useState<any[]>([]);
  const [subject, setSubject] = useState<Record<string, any>>({ beds: 5, baths: 3, maxGuests: 12, price: 750000 });
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/sixgen/import").then((r) => r.json()).then((j) => {
      if (j.error) setErr(j.error);
      else { setPortfolio(j.portfolio); setT12(j.t12 ?? []); }
    });
  }, []);

  const run = useCallback(async () => {
    setBusy(true); setErr(null);
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(subject)) {
      if (v === "" || v == null || v === false) continue;
      p.set(k, v === true ? "1" : String(v));
    }
    const j = await (await fetch(`/api/forecasts?${p}`)).json();
    if (j.error) { setErr(j.error); setResult(null); } else setResult(j);
    setBusy(false);
  }, [subject]);
  useEffect(() => { run(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const set = (k: string, v: any) => setSubject((s) => ({ ...s, [k]: v }));
  const f = result?.forecast;

  return (
    <>
      <PageHeader
        title="Sixgen Comps"
        subtitle="Revenue modelled from Sixgen's own trailing-twelve performance, not from a market average"
        right={portfolio ? <Badge tone="gold">{portfolio.listings} listings · {money(portfolio.t12_revenue)} T12</Badge> : null}
      />

      <div className="space-y-4 p-6">
        {err && <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{err}</div>}

        {portfolio && (
          <Card>
            <CardHeader title="Portfolio basis" subtitle={`Trailing twelve months, ${portfolio.window_start} to ${portfolio.window_end}`} />
            <CardBody className="grid grid-cols-2 gap-4 sm:grid-cols-5">
              <Stat label="Listings" value={portfolio.listings} />
              <Stat label="T12 revenue" value={money(portfolio.t12_revenue)} />
              <Stat label="Occupancy" value={pct(portfolio.occupancy)} hint="floor — blocks unknown" />
              <Stat label="ADR" value={money(portfolio.adr)} />
              <Stat label="Part-year" value={portfolio.partial_year_listings} hint="scaled down as comps" tone={portfolio.partial_year_listings ? "review" : undefined} />
            </CardBody>
          </Card>
        )}

        <div className="grid gap-4 lg:grid-cols-[380px_1fr]">
          <Card>
            <CardHeader title="Subject property" subtitle="What would this house do in Sixgen's hands?" />
            <CardBody className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Bedrooms"><input type="number" min={1} max={20} value={subject.beds ?? ""} onChange={(e) => set("beds", e.target.value)} className={inputCls} /></Field>
                <Field label="Bathrooms"><input type="number" min={1} step={0.5} value={subject.baths ?? ""} onChange={(e) => set("baths", e.target.value)} className={inputCls} /></Field>
                <Field label="Sleeps"><input type="number" min={1} value={subject.maxGuests ?? ""} onChange={(e) => set("maxGuests", e.target.value)} className={inputCls} /></Field>
                <Field label="Purchase price"><input type="number" step={5000} value={subject.price ?? ""} onChange={(e) => set("price", e.target.value)} className={inputCls} /></Field>
              </div>
              <div>
                <div className="mb-1 text-[11px] font-semibold text-slate-600">Amenities</div>
                <div className="grid grid-cols-2 gap-1">
                  {AMENITIES.map(([k, , label]) => (
                    <label key={k} className="flex items-center gap-1.5 text-xs text-slate-600">
                      <input type="checkbox" checked={!!subject[k]} onChange={(e) => set(k, e.target.checked)} />{label}
                    </label>
                  ))}
                </div>
              </div>
              <Button onClick={run} disabled={busy} className="w-full">{busy ? "Modelling…" : "Run comparables"}</Button>
            </CardBody>
          </Card>

          <div className="space-y-4">
            {f && f.compCount > 0 ? (
              <>
                <Card>
                  <CardHeader
                    title="Forecast"
                    subtitle={`${f.compCount} comparables · model ${f.modelVersion}`}
                    right={<Badge tone={confidenceTone(f.confidence)}>{f.confidence} CONFIDENCE</Badge>}
                  />
                  <CardBody>
                    <div className="grid grid-cols-3 gap-4">
                      {(["conservative", "base", "upside"] as const).map((k) => (
                        <div key={k} className={`rounded-lg border p-3 ${k === "base" ? "border-navy bg-slate-50" : "border-slate-200"}`}>
                          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{k}</div>
                          <div className="mt-0.5 text-xl font-bold text-navy">{money(f.scenarios[k].revenue)}</div>
                          <div className="text-xs text-slate-500">{money(f.scenarios[k].adr)} ADR · {pct(f.scenarios[k].occupancy)}</div>
                        </div>
                      ))}
                    </div>
                    {f.grossYieldPct != null && (
                      <div className="mt-3 border-t border-slate-100 pt-3 text-sm">
                        Gross yield at {money(subject.price)}: <b>{f.grossYieldPct}%</b>
                        <span className="ml-2 text-xs text-slate-500">revenue ÷ price, before expenses and financing</span>
                      </div>
                    )}
                    <ul className="mt-3 space-y-1 border-t border-slate-100 pt-3 text-[11px] leading-snug text-slate-500">
                      {f.confidenceReasons.map((r: string) => <li key={r}>• {r}</li>)}
                      {f.notes.map((n: string) => <li key={n}>• {n}</li>)}
                    </ul>
                  </CardBody>
                </Card>

                <Card>
                  <CardHeader title="Comparables used" subtitle="Weighted by similarity and by how much of the year each listing actually traded" />
                  <CardBody className="px-0 py-0">
                    <table className="w-full text-xs">
                      <thead className="bg-slate-50 text-left text-slate-500">
                        <tr><th className="px-4 py-2">Listing</th><th>Bd</th><th>Sleeps</th><th>ADR</th><th>Occ</th><th>T12</th><th>Match</th><th>Weight</th></tr>
                      </thead>
                      <tbody>
                        {f.comps.map((c: any) => (
                          <tr key={c.comp.id} className="border-t border-slate-100 align-top">
                            <td className="px-4 py-2">
                              <div className="font-medium">{c.comp.name}</div>
                              <div className="text-[10px] leading-tight text-slate-400">{c.reasons.join(" · ")}</div>
                            </td>
                            <td>{c.comp.beds ?? "—"}</td>
                            <td>{c.comp.maxGuests ?? "—"}</td>
                            <td>{money(c.comp.adr)}</td>
                            <td>{pct(c.comp.occupancy)}</td>
                            <td>{money(c.comp.grossRevenue)}</td>
                            <td>{(c.similarity * 100).toFixed(0)}%</td>
                            <td className="font-medium">{(c.weight * 100).toFixed(0)}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </CardBody>
                </Card>

                {f.monthly && (
                  <Card>
                    <CardHeader title="Monthly shape" subtitle="The annual base case distributed by the portfolio's own seasonality — not twelve independent predictions" />
                    <CardBody className="px-0 py-0">
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead className="bg-slate-50 text-left text-slate-500"><tr><th className="px-4 py-2">Month</th>{f.monthly.map((m: any) => <th key={m.month}>{MONTHS[m.month - 1]}</th>)}</tr></thead>
                          <tbody>
                            <tr className="border-t border-slate-100"><td className="px-4 py-1.5 text-slate-500">Revenue</td>{f.monthly.map((m: any) => <td key={m.month}>{(m.revenue / 1000).toFixed(0)}k</td>)}</tr>
                            <tr className="border-t border-slate-100"><td className="px-4 py-1.5 text-slate-500">ADR</td>{f.monthly.map((m: any) => <td key={m.month}>{money(m.adr)}</td>)}</tr>
                          </tbody>
                        </table>
                      </div>
                    </CardBody>
                  </Card>
                )}
              </>
            ) : (
              <Card><CardBody className="p-8 text-center text-sm text-slate-500">
                {busy ? "Modelling…" : f ? f.notes[0] : "Import the Sixgen portfolio from Admin, then run a comparable set."}
              </CardBody></Card>
            )}
          </div>
        </div>

        {t12.length > 0 && (
          <Card>
            <CardHeader title="Sixgen portfolio — trailing twelve months" subtitle="The whole comparable pool, so you can see what a forecast is actually built on" />
            <CardBody className="px-0 py-0">
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 text-left text-slate-500">
                    <tr><th className="px-4 py-2">Listing</th><th>Bd</th><th>Ba</th><th>Sleeps</th><th>Amenities</th><th>ADR</th><th>Occ</th><th>T12 revenue</th><th>Months</th></tr>
                  </thead>
                  <tbody>
                    {t12.map((r: any) => (
                      <tr key={r.sixgen_property_id} className="border-t border-slate-100">
                        <td className="px-4 py-1.5 font-medium">{r.name}</td>
                        <td>{r.beds}</td><td>{r.baths}</td><td>{r.max_guests}</td>
                        <td className="text-[10px] text-slate-500">
                          {AMENITIES.filter(([, col]) => r[col]).map(([, , l]) => l).join(", ") || "—"}
                        </td>
                        <td>{money(r.adr)}</td><td>{pct(r.occupancy)}</td><td>{money(r.gross_revenue)}</td>
                        <td>{r.is_partial_year ? <Badge tone="review">{r.months_with_data}/12</Badge> : `${r.months_with_data}/12`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardBody>
          </Card>
        )}
      </div>
    </>
  );
}

const inputCls = "w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm";
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><div className="mb-1 text-[11px] font-semibold text-slate-600">{label}</div>{children}</label>;
}
