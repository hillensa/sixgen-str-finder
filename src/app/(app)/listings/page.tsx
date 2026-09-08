"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import PageHeader from "@/components/PageHeader";
import { Card, CardBody, CardHeader, Stat } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge, classificationTone } from "@/components/ui/badge";
import { SORTS, type SortKey } from "@/lib/listings/query";

type Row = {
  listing_id: number; property_id: number; external_id: string; status: string;
  address: string; unit: string | null; zip: string | null;
  list_price: number | null; original_price: number | null; price_drop: number | null; price_drop_pct: number | null;
  price_per_sqft: number | null; days_on_market: number | null; first_seen: string;
  beds: number | null; baths: number | null; sqft: number | null; year_built: number | null; property_type: string | null;
  pool: boolean | null; garage: boolean | null; basement: boolean | null;
  hoa_status: string; classification: string | null; eligibility_summary: string | null;
  zone_code: string | null; spacing_result: string | null; nearest_str_distance_ft: number | null;
  url: string | null; provider: string;
};

const SORT_LABELS: Record<SortKey, string> = {
  newest: "Newest first", oldest: "Oldest first",
  price_asc: "Price: low to high", price_desc: "Price: high to low",
  price_drop: "Biggest price cut", beds_desc: "Most bedrooms",
  sqft_desc: "Largest", ppsf_asc: "Lowest $/sqft", dom_desc: "Longest on market",
};

const money = (n: number | null) => (n == null ? "—" : `$${Number(n).toLocaleString()}`);
const EMPTY = {
  status: "active", minPrice: "", maxPrice: "", minBeds: "", minBaths: "", minSqft: "",
  zip: "", classification: "", hoa: "", pool: "", maxDom: "", priceDrop: false, screened: false, q: "",
};

export default function AllListings() {
  const [form, setForm] = useState({ ...EMPTY });
  const [applied, setApplied] = useState({ ...EMPTY });
  const [sort, setSort] = useState<SortKey>("newest");
  const [page, setPage] = useState(0);
  const [data, setData] = useState<any>(null);
  const [busy, setBusy] = useState(true);

  const qs = useMemo(() => {
    const p = new URLSearchParams({ market: "lexington-ky", sort, page: String(page), pageSize: "50" });
    for (const [k, v] of Object.entries(applied)) {
      if (v === "" || v === false) continue;
      p.set(k, v === true ? "1" : String(v));
    }
    return p.toString();
  }, [applied, sort, page]);

  const load = useCallback(async () => {
    setBusy(true);
    const j = await (await fetch(`/api/listings?${qs}`)).json();
    setData(j.error ? { error: j.error } : j);
    setBusy(false);
  }, [qs]);
  useEffect(() => { load(); }, [load]);

  const set = (k: string, v: any) => setForm((f) => ({ ...f, [k]: v }));
  const apply = () => { setPage(0); setApplied({ ...form }); };
  const reset = () => { setForm({ ...EMPTY }); setPage(0); setApplied({ ...EMPTY }); };

  const rows: Row[] = data?.listings ?? [];
  const s = data?.summary;
  const pages = data ? Math.ceil((data.total ?? 0) / (data.pageSize || 50)) : 0;

  return (
    <>
      <PageHeader
        title="All Listings"
        subtitle="Every listing the provider has given us, with its latest eligibility screen"
        right={<span className="text-xs text-slate-500">{data ? `${(data.total ?? 0).toLocaleString()} matching` : "…"}</span>}
      />

      <div className="space-y-4 p-6">
        {s && (
          <Card><CardBody className="grid grid-cols-3 gap-4 sm:grid-cols-6">
            <Stat label="Active" value={s.active ?? 0} />
            <Stat label="Median price" value={s.median_price ? money(Math.round(s.median_price)) : "—"} />
            <Stat label="Price cuts" value={s.price_drops ?? 0} />
            <Stat label="Green" value={s.green ?? 0} tone="pass" />
            <Stat label="Yellow" value={s.yellow ?? 0} tone="review" />
            <Stat label="Red" value={s.red ?? 0} tone={s.red ? "fail" : undefined} />
          </CardBody></Card>
        )}

        <Card>
          <CardHeader
            title="Filters"
            subtitle="Optional narrowing on top of the hard acquisition filters (4+ bd · $400K+ · HOA rule)"
            right={
              <select value={sort} onChange={(e) => { setSort(e.target.value as SortKey); setPage(0); }}
                className="rounded-lg border border-slate-300 px-2 py-1 text-xs">
                {SORTS.map((k) => <option key={k} value={k}>{SORT_LABELS[k]}</option>)}
              </select>
            }
          />
          <CardBody>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
              <Field label="Search address"><input value={form.q} onChange={(e) => set("q", e.target.value)} onKeyDown={(e) => e.key === "Enter" && apply()} className={inputCls} placeholder="Cindy Blair" /></Field>
              <Field label="Status"><select value={form.status} onChange={(e) => set("status", e.target.value)} className={inputCls}>
                <option value="">any</option>{["active", "pending", "sold", "removed"].map((x) => <option key={x} value={x}>{x}</option>)}
              </select></Field>
              <Field label="Min price"><input value={form.minPrice} onChange={(e) => set("minPrice", e.target.value)} className={inputCls} placeholder="400000" inputMode="numeric" /></Field>
              <Field label="Max price"><input value={form.maxPrice} onChange={(e) => set("maxPrice", e.target.value)} className={inputCls} inputMode="numeric" /></Field>
              <Field label="Min beds"><input value={form.minBeds} onChange={(e) => set("minBeds", e.target.value)} className={inputCls} placeholder="4" inputMode="numeric" /></Field>
              <Field label="Min baths"><input value={form.minBaths} onChange={(e) => set("minBaths", e.target.value)} className={inputCls} inputMode="numeric" /></Field>
              <Field label="Min sqft"><input value={form.minSqft} onChange={(e) => set("minSqft", e.target.value)} className={inputCls} inputMode="numeric" /></Field>
              <Field label="ZIP"><input value={form.zip} onChange={(e) => set("zip", e.target.value)} className={inputCls} placeholder="40503,40513" /></Field>
              <Field label="Eligibility"><select value={form.classification} onChange={(e) => set("classification", e.target.value)} className={inputCls}>
                <option value="">any</option>{["GREEN", "YELLOW", "RED"].map((x) => <option key={x} value={x}>{x}</option>)}
              </select></Field>
              <Field label="HOA"><select value={form.hoa} onChange={(e) => set("hoa", e.target.value)} className={inputCls}>
                <option value="">any</option>{["VERIFIED_NO_HOA", "HOA_UNKNOWN", "HOA_PRESENT"].map((x) => <option key={x} value={x}>{x.replace(/_/g, " ").toLowerCase()}</option>)}
              </select></Field>
              <Field label="Pool"><select value={form.pool} onChange={(e) => set("pool", e.target.value)} className={inputCls}>
                <option value="">any</option><option value="1">has pool</option><option value="0">no pool</option>
              </select></Field>
              <Field label="Max days on market"><input value={form.maxDom} onChange={(e) => set("maxDom", e.target.value)} className={inputCls} inputMode="numeric" /></Field>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-4">
              <label className="flex items-center gap-1.5 text-xs text-slate-600"><input type="checkbox" checked={form.priceDrop} onChange={(e) => set("priceDrop", e.target.checked)} />Price reduced only</label>
              <label className="flex items-center gap-1.5 text-xs text-slate-600"><input type="checkbox" checked={form.screened} onChange={(e) => set("screened", e.target.checked)} />Screened only</label>
              <div className="ml-auto flex gap-2">
                <Button variant="secondary" onClick={reset}>Reset</Button>
                <Button onClick={apply}>Apply</Button>
              </div>
            </div>

            {data?.activeFilters?.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5 border-t border-slate-100 pt-3">
                {data.activeFilters.map((c: string) => <Badge key={c} tone="info">{c}</Badge>)}
              </div>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardBody className="px-0 py-0">
            {busy && !data ? <div className="p-6 text-sm text-slate-500">Loading…</div>
            : data?.error ? <div className="p-6 text-sm text-red-700">{data.error}</div>
            : !rows.length ? (
              <div className="p-8 text-center text-sm text-slate-500">
                No listings match. {data?.summary?.active ? "Loosen the filters." : "Import a listing set from Admin → Refresh listings first."}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 text-left text-slate-500">
                    <tr>
                      <th className="px-4 py-2">Address</th><th>Price</th><th>Δ</th><th>Bd/Ba</th><th>Sqft</th>
                      <th>$/sqft</th><th>Eligibility</th><th>Separation</th><th>Zone</th><th>HOA</th><th>DOM</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.listing_id} className="border-t border-slate-100 align-top hover:bg-slate-50">
                        <td className="px-4 py-2">
                          <div className="font-medium text-slate-900">{r.address}{r.unit ? ` #${r.unit}` : ""}</div>
                          <div className="text-slate-400">{r.zip} · {r.status}{r.property_type ? ` · ${r.property_type}` : ""}</div>
                        </td>
                        <td className="whitespace-nowrap font-medium">{money(r.list_price)}</td>
                        <td className="whitespace-nowrap">{r.price_drop_pct != null && r.price_drop_pct > 0
                          ? <span className="text-green-700">−{r.price_drop_pct}%</span> : "—"}</td>
                        <td className="whitespace-nowrap">{r.beds ?? "—"}/{r.baths ?? "—"}</td>
                        <td>{r.sqft?.toLocaleString() ?? "—"}</td>
                        <td>{r.price_per_sqft ? `$${r.price_per_sqft}` : "—"}</td>
                        <td>
                          {r.classification
                            ? <Badge tone={classificationTone(r.classification)}>{r.classification}</Badge>
                            : <Badge tone="neutral">not screened</Badge>}
                          {r.eligibility_summary && <div className="mt-0.5 max-w-xs text-[10px] leading-tight text-slate-500">{r.eligibility_summary}</div>}
                        </td>
                        <td className="whitespace-nowrap">
                          {r.spacing_result ?? "—"}
                          {r.nearest_str_distance_ft != null && <div className="text-slate-400">{Math.round(r.nearest_str_distance_ft)} ft</div>}
                        </td>
                        <td>{r.zone_code ?? "—"}</td>
                        <td className="whitespace-nowrap text-[10px]">{r.hoa_status.replace(/_/g, " ").toLowerCase()}</td>
                        <td>{r.days_on_market ?? "—"}</td>
                        <td className="px-3">{r.url && <a href={r.url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">open</a>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {pages > 1 && (
              <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3 text-xs text-slate-500">
                <span>Page {page + 1} of {pages}</span>
                <div className="flex gap-2">
                  <Button variant="secondary" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>Previous</Button>
                  <Button variant="secondary" onClick={() => setPage((p) => p + 1)} disabled={page + 1 >= pages}>Next</Button>
                </div>
              </div>
            )}
          </CardBody>
        </Card>
      </div>
    </>
  );
}

const inputCls = "w-full rounded-lg border border-slate-300 px-2 py-1.5 text-xs";
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><div className="mb-1 text-[11px] font-semibold text-slate-600">{label}</div>{children}</label>;
}
