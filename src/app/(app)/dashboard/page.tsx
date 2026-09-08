import Link from "next/link";
import PageHeader from "@/components/PageHeader";
import { Card, CardBody, CardHeader, Stat } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const s = createClient();
  const [{ count: permits }, { count: blocking }, { count: parcels }, { count: zones }, { data: excl }, { data: rules }, { data: lastImport }, { data: lastRefresh }] = await Promise.all([
    s.from("str_permits").select("*", { count: "exact", head: true }),
    s.from("str_permits").select("*", { count: "exact", head: true }).eq("is_blocking", true),
    s.from("parcels").select("*", { count: "exact", head: true }),
    s.from("zoning_districts").select("*", { count: "exact", head: true }),
    s.from("market_exclusions").select("rules_version,spacing_ft,parcel_count,area_sq_mi,computed_at").maybeSingle(),
    s.from("str_rules").select("rule_key,rule_name,value_num,value_text,enabled,rules_version").order("id"),
    s.from("imports").select("kind,file_name,status,created_at").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    s.from("listing_refreshes").select("started_at,new_count,price_changes,removed,qualified").order("started_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const version = rules?.[0]?.rules_version ?? "—";
  const spacing = rules?.find((r) => r.rule_key === "spacing_ft" && r.enabled)?.value_num;

  return (
    <>
      <PageHeader title="Dashboard" subtitle="Lexington market — Phase 1 foundation" right={<Badge tone="gold">Rules {version}</Badge>} />
      <div className="grid gap-4 p-6 md:grid-cols-2 xl:grid-cols-4">
        <Card><CardBody><Stat label="Existing STR permits" value={permits ?? 0} hint={`${blocking ?? 0} counted as blocking`} /></CardBody></Card>
        <Card><CardBody><Stat label="Parcels cached" value={parcels ?? 0} hint="from LFUCG GIS, on demand" /></CardBody></Card>
        <Card><CardBody><Stat label="Zoning districts cached" value={zones ?? 0} hint="from LFUCG GIS, on demand" /></CardBody></Card>
        <Card><CardBody><Stat label="Spacing rule" value={spacing ? `${spacing} ft` : "—"} hint="editable in Admin → STR Rules" tone={spacing ? "pass" : "review"} /></CardBody></Card>
      </div>

      <div className="grid gap-4 px-6 pb-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Exclusion zone" subtitle="Dissolved buffer around blocking STR parcels (PostGIS)" />
          <CardBody>
            {excl ? (
              <div className="grid grid-cols-3 gap-4">
                <Stat label="Area" value={`${excl.area_sq_mi?.toFixed(2)} mi²`} />
                <Stat label="Source parcels" value={excl.parcel_count} />
                <Stat label="Computed" value={new Date(excl.computed_at).toLocaleDateString()} hint={excl.rules_version} />
              </div>
            ) : (
              <p className="text-sm text-slate-500">Not computed yet. Import STR permits (Phase 2) then rebuild from Admin.</p>
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Data freshness" subtitle="Provenance for the numbers you're looking at" />
          <CardBody className="space-y-2 text-sm">
            <Row k="STR rules" v={`${version} · ${rules?.filter((r) => r.enabled).length ?? 0} enabled`} />
            <Row k="Last import" v={lastImport ? `${lastImport.kind} · ${lastImport.file_name ?? ""} · ${new Date(lastImport.created_at).toLocaleString()}` : "none yet"} />
            <Row k="Last listings refresh" v={lastRefresh ? `${new Date(lastRefresh.started_at).toLocaleString()} · +${lastRefresh.new_count} / ${lastRefresh.price_changes} price Δ / −${lastRefresh.removed}` : "none yet (Phase 4)"} />
            <Row k="GIS source" v="LFUCG ArcGIS (public), fetched live and cached" />
          </CardBody>
        </Card>
      </div>

      <div className="px-6 pb-8">
        <Card>
          <CardHeader title="Phase 1 checklist" subtitle="What works today" />
          <CardBody>
            <ul className="grid gap-2 text-sm md:grid-cols-2">
              {[
                ["✅", "Invite-only login", "/login"], ["✅", "Lexington map with parcel + zoning overlays", "/map"],
                ["✅", "Test any address → parcel → zoning", "/test-address"], ["✅", "STR Rules editor (versioned)", "/admin/rules"],
                ["✅", "PostGIS schema: 34 tables, spatial functions", "/data"], ["⏳", "Permit import wizard (Phase 2)", "/data"],
                ["⏳", "600-ft / density tests in Test Address (Phase 3)", "/test-address"], ["⏳", "Refresh Listings + Top 25 (Phases 4–6)", "/top25"],
              ].map(([i, t, h]) => <li key={t}><Link href={h} className="hover:underline">{i} {t}</Link></li>)}
            </ul>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
function Row({ k, v }: { k: string; v: string }) {
  return <div className="flex justify-between gap-4 border-b border-slate-100 py-1.5 last:border-0"><span className="text-slate-500">{k}</span><span className="text-right font-medium">{v}</span></div>;
}
