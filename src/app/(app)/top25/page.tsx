"use client";
import { Fragment, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import PageHeader from "@/components/PageHeader";
import { Card, CardBody, CardHeader, Stat } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge, classificationTone } from "@/components/ui/badge";
import { factorLabel } from "@/lib/scoring/score";

const money = (n: any) => (n == null ? "—" : `$${Math.round(Number(n)).toLocaleString()}`);
const pct = (n: any) => (n == null ? "—" : `${Number(n).toFixed(1)}%`);

type SortKey = "score" | "gross_yield_pct" | "forecast_revenue" | "list_price" | "beds";

export default function Top25() {
  const [data, setData] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("score");
  const [open, setOpen] = useState<number | null>(null);

  const load = useCallback(async () => {
    const j = await (await fetch("/api/scores?market=lexington-ky&limit=25")).json();
    setData(j.error ? { error: j.error } : j);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function rescore() {
    setBusy("score"); setMsg(null);
    const j = await (await fetch("/api/scores?market=lexington-ky", { method: "POST" })).json();
    setMsg(j.error ?? j.message);
    if (!j.error) await load();
    setBusy(null);
  }

  const rows: any[] = [...(data?.top ?? [])].sort((a, b) => (Number(b[sort] ?? 0) - Number(a[sort] ?? 0)));
  const s = data?.summary;

  return (
    <>
      <PageHeader
        title="Top 25"
        subtitle="Ranked on revenue yield, absolute revenue, comparable strength and upside — after eligibility has gated the list"
        right={<Button onClick={rescore} disabled={busy !== null}>{busy === "score" ? "Ranking…" : "Re-rank"}</Button>}
      />

      <div className="space-y-4 p-6">
        {msg && <div className="rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-700">{msg}</div>}
        {data?.error && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{data.error}</div>}

        {s && (
          <Card><CardBody className="grid grid-cols-3 gap-4 sm:grid-cols-6">
            <Stat label="Candidates" value={s.candidates ?? 0} />
            <Stat label="Ranked" value={(s.scored ?? 0) - (s.gated ?? 0)} tone="pass" />
            <Stat label="Gated" value={s.gated ?? 0} tone={s.gated ? "fail" : undefined} hint="fails a rule" />
            <Stat label="Requires review" value={s.requires_review ?? 0} tone="review" />
            <Stat label="Needs HOA check" value={s.needs_hoa ?? 0} tone="review" />
            <Stat label="Median yield" value={pct(s.median_yield)} />
          </CardBody></Card>
        )}

        <Card>
          <CardHeader
            title="Ranked candidates"
            subtitle={data?.weights?.length ? `Weights: ${data.weights.map((w: any) => `${factorLabel(w.factor_key)} ${(Number(w.weight) * 100).toFixed(0)}%`).join(" · ")}` : undefined}
            right={
              <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className="rounded-lg border border-slate-300 px-2 py-1 text-xs">
                <option value="score">Score</option>
                <option value="gross_yield_pct">Gross yield</option>
                <option value="forecast_revenue">Forecast revenue</option>
                <option value="list_price">Price</option>
                <option value="beds">Bedrooms</option>
              </select>
            }
          />
          <CardBody className="px-0 py-0">
            {!rows.length ? (
              <div className="p-8 text-center text-sm text-slate-500">
                Nothing ranked yet. Refresh listings, run the forecasts, then press <b>Re-rank</b>.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 text-left text-slate-500">
                    <tr>
                      <th className="px-4 py-2">#</th><th>Address</th><th>Price</th><th>Bd/Ba</th><th>Sqft</th>
                      <th>Forecast</th><th>Range</th><th>Yield</th><th>Eligibility</th><th>HOA</th><th>Score</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <Fragment key={r.property_id}>
                        <tr className="border-t border-slate-100 align-top hover:bg-slate-50">
                          <td className="px-4 py-2 font-bold text-slate-400">{sort === "score" ? r.rank ?? i + 1 : i + 1}</td>
                          <td>
                            <Link href={`/property/${r.property_id}`} className="font-medium text-navy hover:underline">{r.address}</Link>
                            <div className="text-slate-400">{r.zip}{r.zone_code ? ` · ${r.zone_code}` : ""}</div>
                          </td>
                          <td className="whitespace-nowrap font-medium">{money(r.list_price)}</td>
                          <td className="whitespace-nowrap">{r.beds ?? "—"}/{r.baths ?? "—"}</td>
                          <td>{r.sqft?.toLocaleString() ?? "—"}</td>
                          <td className="whitespace-nowrap font-medium">{money(r.forecast_revenue)}</td>
                          <td className="whitespace-nowrap text-slate-500">{money(r.forecast_low)}–{money(r.forecast_high)}</td>
                          <td className="font-medium">{pct(r.gross_yield_pct)}</td>
                          <td>{r.classification ? <Badge tone={classificationTone(r.classification)}>{r.classification}</Badge> : <Badge tone="neutral">—</Badge>}</td>
                          <td className="text-[10px]">{String(r.hoa_status ?? "").replace(/_/g, " ").toLowerCase()}</td>
                          <td className="text-sm font-bold text-navy">{r.score == null ? "—" : Number(r.score).toFixed(1)}</td>
                          <td className="px-3">
                            <button onClick={() => setOpen(open === r.property_id ? null : r.property_id)} className="text-blue-600 hover:underline">why</button>
                          </td>
                        </tr>
                        {open === r.property_id && (
                          <tr key={`${r.property_id}-why`} className="border-t border-slate-100 bg-slate-50">
                            <td colSpan={12} className="px-4 py-3">
                              <div className="mb-1 text-[11px] font-bold uppercase tracking-wide text-slate-500">Score breakdown</div>
                              <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-4">
                                {Object.entries(r.breakdown ?? {}).map(([k, v]: [string, any]) => (
                                  <div key={k} className="flex items-baseline justify-between gap-2 text-[11px]">
                                    <span className="text-slate-600">{factorLabel(k)}</span>
                                    <span className={v.normalized == null ? "text-slate-400" : "font-medium"}>
                                      {v.normalized == null ? "n/a" : `${v.points.toFixed(1)} pts`}
                                      <span className="ml-1 text-slate-400">({(v.weight * 100).toFixed(0)}%)</span>
                                    </span>
                                  </div>
                                ))}
                              </div>
                              {r.unavailable_factors?.length > 0 && (
                                <div className="mt-2 text-[11px] text-amber-800">
                                  Weight redistributed — no data for: {r.unavailable_factors.map(factorLabel).join(", ")}.
                                </div>
                              )}
                              {r.eligibility_summary && <div className="mt-2 text-[11px] text-slate-500">{r.eligibility_summary}</div>}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardBody>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <SideList
            title="Needs HOA verification"
            subtitle="Ranked, but an HOA could forbid short-term rental regardless of zoning"
            rows={data?.needsHoaVerification ?? []}
            render={(r) => <>{money(r.list_price)} · {r.beds ?? "—"} bd · {pct(r.gross_yield_pct)} yield</>}
          />
          <SideList
            title="Requires review"
            subtitle="Nothing blocks these, but something material is unverified"
            rows={data?.requiresReview ?? []}
            render={(r) => <span className="text-slate-500">{r.eligibility_summary}</span>}
          />
        </div>

        {data?.gatedCount > 0 && (
          <p className="text-xs text-slate-500">
            {data.gatedCount} propert{data.gatedCount === 1 ? "y is" : "ies are"} excluded from the ranking entirely — they fail a rule this tool can evaluate,
            and a score would only invite trading that failure off against yield.
          </p>
        )}
      </div>
    </>
  );
}

function SideList({ title, subtitle, rows, render }: { title: string; subtitle: string; rows: any[]; render: (r: any) => React.ReactNode }) {
  return (
    <Card>
      <CardHeader title={title} subtitle={subtitle} right={<Badge tone="review">{rows.length}</Badge>} />
      <CardBody className="px-0 py-0">
        {!rows.length ? <div className="p-6 text-center text-sm text-slate-500">Nothing here.</div> : (
          <div className="divide-y divide-slate-100">
            {rows.map((r) => (
              <Link key={r.property_id} href={`/property/${r.property_id}`} className="block px-5 py-2.5 hover:bg-slate-50">
                <div className="text-sm font-medium text-navy">{r.address}</div>
                <div className="text-[11px] leading-snug text-slate-500">{render(r)}</div>
              </Link>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
