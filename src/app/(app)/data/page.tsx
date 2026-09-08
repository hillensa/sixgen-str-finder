import Link from "next/link";
import PageHeader from "@/components/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { createClient } from "@/lib/supabase/server";
export const dynamic = "force-dynamic";

export default async function DataPage() {
  const s = createClient();
  const { data: imports } = await s.from("imports").select("*").order("created_at", { ascending: false }).limit(20);
  const { data: j } = await s.from("jurisdictions").select("*").limit(1).maybeSingle();
  const sources = [
    ["Existing STR permits", "LFUCG Short_Term_Rental_Public_view + ORR-2026-1259 file", "Import wizard live", "pass"],
    ["Parcels", j?.gis_parcel_url ?? "—", "Live, cached on lookup", "pass"],
    ["Zoning", j?.gis_zoning_url ?? "—", "Live, cached on lookup", "pass"],
    ["Address points (geocoder)", j?.gis_address_url ?? "—", "Live", "pass"],
    ["Homes for sale", "ListingsProvider: csv | json | reso", "Phase 4", "review"],
    ["Sixgen historical performance", "CSV/XLSX wizard or Guesty connector", "Phase 5", "review"],
  ] as const;
  return (
    <>
      <PageHeader title="Data" subtitle="Sources, imports, and provenance" />
      <div className="grid gap-4 p-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Data sources" subtitle="Where every number comes from" />
          <CardBody className="space-y-3 text-sm">
            {sources.map(([n, src, st, tone]) => (
              <div key={n} className="flex items-start justify-between gap-3 border-b border-slate-100 pb-2 last:border-0">
                <div><div className="font-medium">{n}</div><div className="break-all text-xs text-slate-500">{src}</div></div>
                <Badge tone={tone as any}>{st}</Badge>
              </div>
            ))}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Import history" subtitle="Every file, with match statistics" right={<div className="flex items-center gap-3"><Link href="/data/permits" className="text-xs font-semibold text-blue-600 underline">Import STR permits →</Link><Link href="/data/collector" className="text-xs text-blue-600 underline">Browser export helper</Link></div>} />
          <CardBody>
            {imports?.length ? (
              <table className="w-full text-xs"><thead><tr className="text-left text-slate-500"><th>When</th><th>Kind</th><th>File</th><th>Rows</th><th>Matched</th><th>Report</th><th>Status</th></tr></thead>
                <tbody>{imports.map((i) => <tr key={i.id} className="border-t border-slate-100"><td className="py-1.5">{new Date(i.created_at).toLocaleString()}</td><td>{i.kind}</td><td className="max-w-[140px] truncate">{i.file_name}</td><td>{i.row_count}</td><td>{i.matched}</td><td>{i.kind === "str_permits" && i.file_name !== "LFUCG GIS layer" ? <Link href={"/data/permits/" + i.id} className="text-blue-600 underline">open</Link> : null}</td><td><Badge tone={i.status === "complete" ? "pass" : i.status === "failed" ? "fail" : "review"}>{i.status}</Badge></td></tr>)}</tbody></table>
            ) : <p className="text-sm text-slate-500">No imports yet. Start with <Link href="/data/permits" className="text-blue-600 underline">Import STR permits</Link>.</p>}
          </CardBody>
        </Card>
      </div>
    </>
  );
}
