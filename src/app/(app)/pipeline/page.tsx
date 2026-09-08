"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import PageHeader from "@/components/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Badge, classificationTone } from "@/components/ui/badge";

const money = (n: any) => (n == null ? "—" : `$${Math.round(Number(n)).toLocaleString()}`);

export default function Pipeline() {
  const [data, setData] = useState<any>(null);
  const [moving, setMoving] = useState<number | null>(null);

  const load = useCallback(async () => {
    const j = await (await fetch("/api/pipeline?market=lexington-ky")).json();
    setData(j.error ? { error: j.error } : j);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function move(propertyId: number, status: string) {
    setMoving(propertyId);
    await fetch(`/api/properties/${propertyId}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "pipeline", status }),
    });
    await load();
    setMoving(null);
  }

  const statuses: string[] = data?.statuses ?? [];
  const items: any[] = data?.items ?? [];
  const saved: any[] = data?.saved ?? [];

  return (
    <>
      <PageHeader
        title="Pipeline"
        subtitle="Every property being worked, by stage"
        right={<span className="text-xs text-slate-500">{items.length} in pipeline · {saved.length} saved</span>}
      />

      <div className="space-y-4 p-6">
        {data?.error && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{data.error}</div>}

        {!items.length && !saved.length && data && !data.error && (
          <Card><CardBody className="p-8 text-center text-sm text-slate-500">
            Nothing in the pipeline yet. Open a property from <Link href="/top25" className="text-blue-600 underline">Top 25</Link> and set a stage.
          </CardBody></Card>
        )}

        {items.length > 0 && (
          <div className="flex gap-3 overflow-x-auto pb-2">
            {statuses.map((st) => {
              const col = items.filter((i) => i.status === st);
              return (
                <div key={st} className="w-64 shrink-0">
                  <div className="mb-2 flex items-center justify-between px-1">
                    <span className="text-xs font-bold uppercase tracking-wide text-slate-600">{st}</span>
                    <span className="text-[11px] text-slate-400">{col.length}</span>
                  </div>
                  <div className="space-y-2">
                    {col.map((i) => (
                      <div key={i.property_id} className={`rounded-lg border border-slate-200 bg-white p-3 shadow-sm ${moving === i.property_id ? "opacity-50" : ""}`}>
                        <Link href={`/property/${i.property_id}`} className="text-sm font-medium text-navy hover:underline">{i.property.address}</Link>
                        <div className="mt-0.5 text-[11px] text-slate-500">
                          {money(i.property.list_price)} · {i.property.beds ?? "—"} bd
                          {i.score != null && <> · score {Number(i.score).toFixed(1)}</>}
                        </div>
                        <div className="mt-1 flex items-center gap-1">
                          {i.property.classification && <Badge tone={classificationTone(i.property.classification)}>{i.property.classification}</Badge>}
                          {i.property.forecast_revenue && <span className="text-[10px] text-slate-500">{money(i.property.forecast_revenue)}/yr</span>}
                        </div>
                        {i.next_action && <div className="mt-1 text-[10px] text-amber-800">Next: {i.next_action}</div>}
                        <select value={i.status} disabled={moving !== null}
                          onChange={(e) => move(i.property_id, e.target.value)}
                          className="mt-2 w-full rounded border border-slate-200 px-1.5 py-1 text-[11px] text-slate-600">
                          {statuses.map((s) => <option key={s} value={s}>{s}</option>)}
                        </select>
                      </div>
                    ))}
                    {!col.length && <div className="rounded-lg border border-dashed border-slate-200 p-4 text-center text-[11px] text-slate-400">Empty</div>}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {saved.length > 0 && (
          <Card>
            <CardHeader title="Saved properties" subtitle="Yours — not necessarily in the pipeline" />
            <CardBody className="px-0 py-0">
              <div className="divide-y divide-slate-100">
                {saved.map((p) => (
                  <Link key={p.property_id} href={`/property/${p.property_id}`} className="flex items-center justify-between px-5 py-2.5 hover:bg-slate-50">
                    <div>
                      <div className="text-sm font-medium text-navy">{p.address}</div>
                      <div className="text-[11px] text-slate-500">{money(p.list_price)} · {p.beds ?? "—"} bd · {money(p.forecast_revenue)}/yr</div>
                    </div>
                    <div className="flex items-center gap-2">
                      {p.classification && <Badge tone={classificationTone(p.classification)}>{p.classification}</Badge>}
                      {p.score != null && <span className="text-sm font-bold text-navy">{Number(p.score).toFixed(1)}</span>}
                    </div>
                  </Link>
                ))}
              </div>
            </CardBody>
          </Card>
        )}
      </div>
    </>
  );
}
