"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import PageHeader from "@/components/PageHeader";
import { Card, CardBody, CardHeader, Stat } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

type Permit = {
  id: number; address_norm: string | null; address_raw: string | null; unit: string | null; zip: string | null;
  str_type: string | null; permit_status: string | null; is_blocking: boolean | null; blocking_reason: string | null;
  lat: number | null; lng: number | null; parcel_id: number | null;
  match_status: string | null; match_confidence: number | null; match_method: string | null;
  geocode_method: string | null; address_confidence: number | null; review_note: string | null;
};
type Row = { id: number; row_number: number; status: string | null; error: string | null; raw: Record<string, string>; permit: Permit | null };
type Candidate = { parcel_id: number; address: string | null; zone_code: string | null; distance_ft: number; contains_point: boolean };

const TABS = ["all", "matched", "possible", "unmatched", "duplicate", "invalid"] as const;
const tone = (s: string | null) =>
  s === "matched" ? "pass" : s === "possible" ? "review" : s === "duplicate" ? "info" : s === "invalid" ? "fail" : "neutral";

export default function MatchReport({ params }: { params: { id: string } }) {
  const [tab, setTab] = useState<(typeof TABS)[number]>("all");
  const [page, setPage] = useState(0);
  const [data, setData] = useState<any>(null);
  const [open, setOpen] = useState<Row | null>(null);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    const j = await (await fetch(`/api/imports/${params.id}?status=${tab}&page=${page}`)).json();
    setData(j.error ? null : j);
    if (j.error) setMsg(j.error);
  }, [params.id, tab, page]);
  useEffect(() => { load(); }, [load]);

  async function rebuild() {
    setBusy("rebuild"); setMsg(null);
    const j = await (await fetch("/api/exclusions/rebuild?jurisdiction=lfucg", { method: "POST" })).json();
    setMsg(j.error ?? `Exclusion rebuilt — ${j.blocking?.blocking ?? 0} blocking permits, ${j.exclusion ? Number(j.exclusion.area_sq_mi).toFixed(2) : "0.00"} mi².`);
    if (!j.error) setStale(false);
    setBusy(null);
  }

  const counts: Record<string, number> = data?.counts ?? {};
  const imp = data?.import;

  return (
    <>
      <PageHeader
        title="Permit match report"
        subtitle={imp ? `${imp.file_name} · ${new Date(imp.created_at).toLocaleString()}` : "Loading…"}
        right={
          <div className="flex items-center gap-2">
            {stale && <Badge tone="review">Exclusion is stale</Badge>}
            <Button variant={stale ? "gold" : "secondary"} onClick={rebuild} disabled={busy !== null}>
              {busy === "rebuild" ? "Rebuilding…" : "Rebuild exclusion"}
            </Button>
            <Link href="/data/permits" className="text-xs text-blue-600 underline">New import</Link>
          </div>
        }
      />

      <div className="space-y-4 p-6">
        {msg && <div className="rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-700">{msg}</div>}

        <Card>
          <CardBody className="grid grid-cols-3 gap-4 sm:grid-cols-6">
            <Stat label="Rows" value={imp?.row_count ?? "—"} />
            <Stat label="Matched" value={counts.matched ?? 0} tone="pass" />
            <Stat label="Possible" value={counts.possible ?? 0} tone="review" />
            <Stat label="Unmatched" value={counts.unmatched ?? 0} tone={counts.unmatched ? "fail" : undefined} />
            <Stat label="Duplicate" value={counts.duplicate ?? 0} />
            <Stat label="Invalid" value={counts.invalid ?? 0} tone={counts.invalid ? "fail" : undefined} />
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Rows"
            subtitle="Only an exact hit in the city address file counts as matched. Everything else is here to be checked."
            right={
              <div className="flex flex-wrap gap-1">
                {TABS.map((t) => (
                  <button key={t} onClick={() => { setTab(t); setPage(0); }}
                    className={`rounded-full px-2.5 py-1 text-[11px] font-semibold capitalize transition ${tab === t ? "bg-navy text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>
                    {t}{t !== "all" && counts[t] != null ? ` ${counts[t]}` : ""}
                  </button>
                ))}
              </div>
            }
          />
          <CardBody>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead><tr className="text-left text-slate-500">
                  <th className="py-1">#</th><th>Address</th><th>Located by</th><th>Conf.</th><th>Parcel</th><th>Type</th><th>Blocking</th><th>Status</th><th />
                </tr></thead>
                <tbody>
                  {(data?.rows ?? []).map((r: Row) => (
                    <tr key={r.id} className="border-t border-slate-100 align-top">
                      <td className="py-1.5 text-slate-400">{r.row_number}</td>
                      <td>
                        <div className="font-medium">{r.permit?.address_norm ?? r.raw?.address ?? "—"}</div>
                        {r.permit?.unit && <span className="text-slate-500">Unit {r.permit.unit} · </span>}
                        <span className="text-slate-400">{r.permit?.zip ?? ""}</span>
                        {r.error && <div className="max-w-md text-[10px] leading-tight text-red-600">{r.error}</div>}
                      </td>
                      <td>{r.permit?.geocode_method ?? "—"}</td>
                      <td>{r.permit?.address_confidence != null ? Number(r.permit.address_confidence).toFixed(2) : "—"}</td>
                      <td>{r.permit?.parcel_id ?? <span className="text-slate-400">none</span>}</td>
                      <td>{r.permit?.str_type ?? <Badge tone="review">unknown</Badge>}</td>
                      <td>{r.permit?.is_blocking ? <Badge tone="fail">blocking</Badge> : <Badge tone="neutral">no</Badge>}</td>
                      <td><Badge tone={tone(r.status) as any}>{r.status ?? "—"}</Badge></td>
                      <td className="text-right">
                        {r.permit && <button onClick={() => setOpen(r)} className="text-blue-600 hover:underline">Fix</button>}
                      </td>
                    </tr>
                  ))}
                  {!data?.rows?.length && <tr><td colSpan={9} className="py-6 text-center text-slate-500">No rows with this status.</td></tr>}
                </tbody>
              </table>
            </div>

            {data && data.total > data.pageSize && (
              <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
                <span>{page * data.pageSize + 1}–{Math.min((page + 1) * data.pageSize, data.total)} of {data.total}</span>
                <div className="flex gap-2">
                  <Button variant="secondary" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>Previous</Button>
                  <Button variant="secondary" onClick={() => setPage((p) => p + 1)} disabled={(page + 1) * data.pageSize >= data.total}>Next</Button>
                </div>
              </div>
            )}
          </CardBody>
        </Card>
      </div>

      {open?.permit && (
        <FixPanel
          row={open}
          onClose={() => setOpen(null)}
          onSaved={(note) => { setStale(true); setMsg(note); setOpen(null); load(); }}
        />
      )}
    </>
  );
}

function FixPanel({ row, onClose, onSaved }: { row: Row; onClose: () => void; onSaved: (note: string) => void }) {
  const p = row.permit!;
  const [address, setAddress] = useState(p.address_raw ?? p.address_norm ?? "");
  const [lat, setLat] = useState(p.lat?.toString() ?? "");
  const [lng, setLng] = useState(p.lng?.toString() ?? "");
  const [strType, setStrType] = useState(p.str_type ?? "");
  const [status, setStatus] = useState(p.permit_status ?? "unknown");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/permits/${p.id}`).then((r) => r.json()).then((j) => setCandidates(j.candidates ?? []));
  }, [p.id]);

  async function send(body: any, label: string) {
    setBusy(label); setErr(null);
    const j = await (await fetch(`/api/permits/${p.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
    setBusy(null);
    if (j.error) { setErr(j.error); return null; }
    return j;
  }

  async function saveDetails() {
    const body: any = {};
    if (address.trim() && address.trim() !== (p.address_raw ?? "")) body.address = address.trim();
    if (strType !== (p.str_type ?? "")) body.str_type = strType || null;
    if (status !== (p.permit_status ?? "")) body.permit_status = status;
    if (lat && lng && (Number(lat) !== p.lat || Number(lng) !== p.lng)) { body.lat = Number(lat); body.lng = Number(lng); }
    if (!Object.keys(body).length) { setErr("Nothing changed."); return; }
    const j = await send(body, "save");
    if (j) onSaved(`Row ${row.row_number} updated (${j.changed.join(", ")}). ${j.blocking?.blocking ?? 0} permits now blocking.`);
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/30" onClick={onClose}>
      <div className="h-full w-full max-w-md overflow-auto bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <div className="text-sm font-semibold text-navy">Fix row {row.row_number}</div>
            <div className="text-xs text-slate-500">{p.address_norm ?? "—"}</div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700">✕</button>
        </div>

        <div className="space-y-4 px-5 py-4 text-sm">
          <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
            Located by <b>{p.geocode_method ?? "nothing"}</b>
            {p.address_confidence != null && <> at confidence <b>{Number(p.address_confidence).toFixed(2)}</b></>}
            {p.blocking_reason && <div className="mt-1">Blocking: {p.blocking_reason}</div>}
            {p.review_note && <div className="mt-1 text-amber-800">{p.review_note}</div>}
            <div className="mt-1">Saving marks this permit <b>manual</b>, so the next city sync will not overwrite it.</div>
          </div>

          <label className="block">
            <div className="mb-1 text-xs font-semibold text-slate-600">Address</div>
            <input value={address} onChange={(e) => setAddress(e.target.value)} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
          </label>

          <div className="flex gap-2">
            <Button variant="secondary" disabled={busy !== null}
              onClick={async () => { const j = await send({ address: address.trim(), regeocode: true }, "geo"); if (j) { setLat(String(j.permit.lat ?? "")); setLng(String(j.permit.lng ?? "")); onSaved(`Row ${row.row_number} re-geocoded via ${j.permit.geocode_method}.`); } }}>
              {busy === "geo" ? "Geocoding…" : "Re-geocode"}
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <label><div className="mb-1 text-xs font-semibold text-slate-600">Latitude</div>
              <input value={lat} onChange={(e) => setLat(e.target.value)} className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" /></label>
            <label><div className="mb-1 text-xs font-semibold text-slate-600">Longitude</div>
              <input value={lng} onChange={(e) => setLng(e.target.value)} className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm" /></label>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <label><div className="mb-1 text-xs font-semibold text-slate-600">Type</div>
              <select value={strType} onChange={(e) => setStrType(e.target.value)} className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm">
                <option value="">unknown (blocks by default)</option>
                <option value="unhosted">unhosted</option>
                <option value="hosted">hosted</option>
              </select></label>
            <label><div className="mb-1 text-xs font-semibold text-slate-600">Permit status</div>
              <select value={status} onChange={(e) => setStatus(e.target.value)} className="w-full rounded-lg border border-slate-300 px-2 py-1.5 text-sm">
                {["active", "expired", "pending", "revoked", "unknown"].map((x) => <option key={x} value={x}>{x}</option>)}
              </select></label>
          </div>

          <div>
            <div className="mb-1 text-xs font-semibold text-slate-600">Parcel</div>
            {candidates.length ? (
              <div className="divide-y rounded-lg border">
                {candidates.map((c) => (
                  <button key={c.parcel_id} disabled={busy !== null}
                    onClick={async () => { const j = await send({ parcel_id: c.parcel_id }, "parcel"); if (j) onSaved(`Row ${row.row_number} linked to parcel ${c.parcel_id}.`); }}
                    className={`flex w-full items-center justify-between px-3 py-2 text-left text-xs hover:bg-slate-50 ${p.parcel_id === c.parcel_id ? "bg-blue-50" : ""}`}>
                    <span>
                      <span className="font-medium">{c.address || `Parcel ${c.parcel_id}`}</span>
                      {c.zone_code && <span className="ml-1 text-slate-500">{c.zone_code}</span>}
                    </span>
                    <span className="text-slate-500">{c.contains_point ? <Badge tone="pass">contains point</Badge> : `${c.distance_ft} ft`}</span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-xs text-slate-500">
                {p.lat == null ? "No coordinates yet — geocode or enter lat/lng first." : "No cached parcel within 300 ft. Run the city sync, or set coordinates that fall inside a parcel."}
              </p>
            )}
          </div>

          {err && <div className="rounded-lg border border-red-200 bg-red-50 p-2 text-xs text-red-800">{err}</div>}

          <div className="flex gap-2 border-t border-slate-100 pt-3">
            <Button onClick={saveDetails} disabled={busy !== null}>{busy === "save" ? "Saving…" : "Save changes"}</Button>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
