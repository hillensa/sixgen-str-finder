"use client";
import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import PageHeader from "@/components/PageHeader";
import { Card, CardBody, CardHeader, Stat } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

type Field = { key: string; label: string; group: string; hint?: string };
type Analysis = {
  fileName: string; kind: "csv" | "xlsx";
  sheets: string[]; sheetName: string | null; headerRow: number;
  headers: string[]; rowCount: number; sample: Record<string, string>[];
  mapping: Record<string, string>; unmapped: string[];
  errors: string[]; warnings: string[]; fields: Field[];
  preview: { rowNumber: number; addressRaw: string; addressNorm: string; unit: string | null; zip: string | null; permitNumber: string | null; strType: string | null; permitStatus: string; status: string; errors: string[] }[];
  previewCounts: { total: number; ready: number; invalid: number; duplicate: number; unclassified: number; withCoords: number };
};

const GROUPS: [string, string][] = [
  ["identity", "Identity"], ["address", "Address"], ["classification", "Classification"],
  ["dates", "Dates"], ["geometry", "Coordinates"], ["other", "Other"],
];
const statusTone = (s: string) => (s === "ready" ? "pass" : s === "duplicate" ? "review" : "fail");

export default function PermitImportWizard() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [sheet, setSheet] = useState("");
  const [headerRow, setHeaderRow] = useState(1);
  const [a, setA] = useState<Analysis | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [useCensus, setUseCensus] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<any>(null);

  async function analyze(f: File, opts: { sheet?: string; headerRow?: number; mapping?: Record<string, string> } = {}) {
    setBusy("analyze"); setErr(null); setResult(null);
    const fd = new FormData();
    fd.set("file", f);
    if (opts.sheet ?? sheet) fd.set("sheet", opts.sheet ?? sheet);
    fd.set("headerRow", String(opts.headerRow ?? headerRow));
    if (opts.mapping) fd.set("mapping", JSON.stringify(opts.mapping));
    try {
      const j = await (await fetch("/api/imports/permits/analyze", { method: "POST", body: fd })).json();
      if (j.error) { setErr(j.error); setA(null); }
      else { setA(j); setMapping(j.mapping); if (j.sheetName && !sheet) setSheet(j.sheetName); }
    } catch (e: any) { setErr(e.message); }
    setBusy(null);
  }

  function onPick(f: File | null) {
    setFile(f); setA(null); setResult(null); setSheet(""); setHeaderRow(1);
    if (f) analyze(f, { sheet: "", headerRow: 1 });
  }

  function setField(field: string, header: string) {
    const next = { ...mapping };
    if (header) next[field] = header; else delete next[field];
    setMapping(next);
  }

  async function commit() {
    if (!file) return;
    setBusy("commit"); setErr(null);
    const fd = new FormData();
    fd.set("file", file); fd.set("mapping", JSON.stringify(mapping));
    fd.set("sheet", sheet); fd.set("headerRow", String(headerRow));
    fd.set("jurisdiction", "lfucg"); fd.set("useCensus", String(useCensus));
    try {
      const j = await (await fetch("/api/imports/permits/commit", { method: "POST", body: fd })).json();
      if (j.error) setErr(j.errors?.length ? `${j.error} ${j.errors.join(" ")}` : j.error);
      else setResult(j);
    } catch (e: any) { setErr(e.message); }
    setBusy(null);
  }

  const errors = a ? a.errors : [];
  const canCommit = !!a && errors.length === 0 && a.previewCounts.ready > 0 && !busy;

  return (
    <>
      <PageHeader
        title="Import STR permits"
        subtitle="City spreadsheet → normalized address → geocode → parcel match → 600-ft exclusion"
        right={<Link href="/data" className="text-xs text-blue-600 underline">← Data</Link>}
      />

      <div className="space-y-4 p-6">
        {/* 1 · file */}
        <Card>
          <CardHeader title="1 · Choose the file" subtitle="CSV, TSV, or XLSX. Nothing is written until you commit in step 4." />
          <CardBody>
            <div className="flex flex-wrap items-center gap-3">
              <input ref={fileRef} type="file" accept=".csv,.tsv,.txt,.xlsx" onChange={(e) => onPick(e.target.files?.[0] ?? null)}
                className="text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-navy file:px-3.5 file:py-2 file:text-sm file:font-semibold file:text-white" />
              {busy === "analyze" && <span className="text-xs text-slate-500">Reading…</span>}
            </div>

            {a && (
              <div className="mt-4 flex flex-wrap items-end gap-4 border-t border-slate-100 pt-3 text-sm">
                {a.sheets.length > 1 && (
                  <label className="text-xs">
                    <div className="mb-1 font-semibold text-slate-600">Worksheet</div>
                    <select value={sheet} onChange={(e) => { setSheet(e.target.value); file && analyze(file, { sheet: e.target.value }); }}
                      className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm">
                      {a.sheets.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </label>
                )}
                <label className="text-xs">
                  <div className="mb-1 font-semibold text-slate-600">Header row</div>
                  <input type="number" min={1} value={headerRow}
                    onChange={(e) => setHeaderRow(Number(e.target.value) || 1)}
                    onBlur={() => file && analyze(file, { headerRow })}
                    className="w-20 rounded-lg border border-slate-300 px-2 py-1.5 text-sm" />
                </label>
                <div className="text-xs text-slate-500">
                  <b>{a.rowCount.toLocaleString()}</b> data rows · <b>{a.headers.length}</b> columns · {a.kind.toUpperCase()}
                </div>
              </div>
            )}
          </CardBody>
        </Card>

        {a && (
          <>
            {/* 2 · mapping */}
            <Card>
              <CardHeader
                title="2 · Map the columns"
                subtitle="Column names differ between files and even between tabs of the same file, so nothing is assumed."
                right={<Button variant="secondary" onClick={() => file && analyze(file, { mapping })} disabled={!!busy}>Re-preview</Button>}
              />
              <CardBody>
                <div className="grid gap-x-8 gap-y-1 md:grid-cols-2">
                  {GROUPS.map(([g, label]) => {
                    const fields = a.fields.filter((f) => f.group === g);
                    if (!fields.length) return null;
                    return (
                      <div key={g} className="mb-3">
                        <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-400">{label}</div>
                        {fields.map((f) => (
                          <div key={f.key} className="mb-1.5">
                            <div className="flex items-center gap-2">
                              <label className="w-40 shrink-0 text-xs text-slate-700">{f.label}</label>
                              <select value={mapping[f.key] ?? ""} onChange={(e) => setField(f.key, e.target.value)}
                                className="min-w-0 flex-1 rounded-lg border border-slate-300 px-2 py-1 text-xs">
                                <option value="">— not mapped —</option>
                                {a.headers.map((h) => {
                                  const k = h.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
                                  return <option key={k} value={k}>{h}</option>;
                                })}
                              </select>
                            </div>
                            {f.hint && <div className="ml-42 pl-1 text-[10px] leading-tight text-slate-400">{f.hint}</div>}
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>

                {errors.length > 0 && (
                  <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800">
                    {errors.map((e) => <div key={e}>• {e}</div>)}
                  </div>
                )}
                {a.warnings.length > 0 && (
                  <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                    {a.warnings.map((w) => <div key={w}>• {w}</div>)}
                  </div>
                )}
              </CardBody>
            </Card>

            {/* 3 · preview */}
            <Card>
              <CardHeader title="3 · Preview" subtitle={`First ${a.preview.length} rows, normalized exactly as they will be imported`} />
              <CardBody>
                <div className="mb-3 grid grid-cols-3 gap-4 sm:grid-cols-6">
                  <Stat label="Rows" value={a.rowCount.toLocaleString()} />
                  <Stat label="Ready" value={a.previewCounts.ready} tone="pass" hint="of the sample" />
                  <Stat label="Duplicate" value={a.previewCounts.duplicate} tone="review" hint="of the sample" />
                  <Stat label="Invalid" value={a.previewCounts.invalid} tone={a.previewCounts.invalid ? "fail" : undefined} hint="of the sample" />
                  <Stat label="No type" value={a.previewCounts.unclassified} tone={a.previewCounts.unclassified ? "review" : undefined} hint="blocking by default" />
                  <Stat label="Has coords" value={a.previewCounts.withCoords} hint="geocode skipped" />
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead><tr className="text-left text-slate-500">
                      <th className="py-1">#</th><th>Normalized address</th><th>Unit</th><th>ZIP</th><th>License</th><th>Type</th><th>Status</th><th>Row</th>
                    </tr></thead>
                    <tbody>
                      {a.preview.map((p) => (
                        <tr key={p.rowNumber} className="border-t border-slate-100 align-top">
                          <td className="py-1.5 text-slate-400">{p.rowNumber}</td>
                          <td className="font-medium">{p.addressNorm || <span className="text-slate-400">{p.addressRaw || "—"}</span>}</td>
                          <td>{p.unit ?? "—"}</td><td>{p.zip ?? "—"}</td><td>{p.permitNumber ?? "—"}</td>
                          <td>{p.strType ?? <Badge tone="review">unknown</Badge>}</td>
                          <td>{p.permitStatus}</td>
                          <td><Badge tone={statusTone(p.status) as any}>{p.status}</Badge>
                            {p.errors.length > 0 && <div className="mt-0.5 max-w-xs text-[10px] leading-tight text-slate-500">{p.errors.join(" ")}</div>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CardBody>
            </Card>

            {/* 4 · commit */}
            <Card>
              <CardHeader title="4 · Import" subtitle="Geocodes every row, matches parcels, then rebuilds the 600-ft exclusion in PostGIS" />
              <CardBody>
                <label className="mb-3 flex items-center gap-2 text-xs text-slate-600">
                  <input type="checkbox" checked={useCensus} onChange={(e) => setUseCensus(e.target.checked)} />
                  Fall back to the US Census geocoder when the city address file has no match
                  <span className="text-slate-400">(interpolated — never scores as a confident match)</span>
                </label>
                <div className="flex items-center gap-3">
                  <Button onClick={commit} disabled={!canCommit}>{busy === "commit" ? "Importing…" : `Import ${a.rowCount.toLocaleString()} rows`}</Button>
                  {busy === "commit" && <span className="text-xs text-slate-500">Geocoding is rate-limited; a 1,000-row file takes a minute or two.</span>}
                </div>

                {result && (
                  <div className="mt-4 rounded-lg border border-green-200 bg-green-50 p-4 text-sm">
                    <div className="font-semibold text-green-900">Import complete</div>
                    <div className="mt-1 grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-green-900 sm:grid-cols-4">
                      <div>Matched: <b>{result.counts.matched}</b></div>
                      <div>Possible: <b>{result.counts.possible}</b></div>
                      <div>Unmatched: <b>{result.counts.unmatched}</b></div>
                      <div>Duplicate: <b>{result.counts.duplicate}</b></div>
                      <div>Invalid: <b>{result.counts.invalid}</b></div>
                      <div>Blocking now: <b>{result.blocking?.blocking ?? "—"}</b></div>
                      <div>Parcels cached: <b>{result.parcels}</b></div>
                      <div>Exclusion: <b>{result.exclusion ? `${Number(result.exclusion.area_sq_mi).toFixed(2)} mi²` : "—"}</b></div>
                    </div>
                    <div className="mt-3 flex gap-2">
                      <Button variant="gold" onClick={() => router.push(`/data/permits/${result.importId}`)}>Open match report →</Button>
                      <Link href="/map"><Button variant="secondary">View map</Button></Link>
                    </div>
                  </div>
                )}
              </CardBody>
            </Card>
          </>
        )}

        {err && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{err}</div>}
      </div>
    </>
  );
}
