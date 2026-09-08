"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import PageHeader from "@/components/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export default function AdminPage() {
  const [busy, setBusy] = useState<string | null>(null); const [log, setLog] = useState<string[]>([]);
  const [invites, setInvites] = useState<any>(null); const [email, setEmail] = useState("");
  const [payload, setPayload] = useState(""); const [fmt, setFmt] = useState<"csv" | "json">("csv");
  const [elig, setElig] = useState<Record<string, number> | null>(null);
  const [fullSync, setFullSync] = useState(false);
  const [sixgenProps, setSixgenProps] = useState<File | null>(null);
  const [sixgenMonthly, setSixgenMonthly] = useState<File | null>(null);
  const say = (m: string) => setLog((l) => [`${new Date().toLocaleTimeString()} — ${m}`, ...l].slice(0, 50));
  const loadInvites = () => fetch("/api/invite").then((r) => r.json()).then((d) => d.error ? say(`Invites: ${d.error}`) : setInvites(d));
  const loadElig = () => fetch("/api/eligibility/rerun?market=lexington-ky").then((r) => r.json()).then((d) => { if (!d.error) setElig(d.counts ?? {}); });
  useEffect(() => { loadInvites(); loadElig(); }, []);

  async function refreshGis() {
    setBusy("gis"); say("Syncing LFUCG STR layer → parcels → PostGIS exclusion…");
    try { const j = await (await fetch("/api/refresh?jurisdiction=lfucg", { method: "POST" })).json();
      say(j.error ? `❌ ${j.error}` : `✅ ${j.permits} permits (${j.unhosted} unhosted) · ${j.parcels} parcels · exclusion ${j.exclusion ? `${Number(j.exclusion.area_sq_mi).toFixed(2)} mi²` : "—"} · ${(j.elapsedMs / 1000).toFixed(1)}s`);
    } catch (e: any) { say(`❌ ${e.message}`); } setBusy(null);
  }
  async function rerunEligibility() {
    setBusy("elig"); say("Linking parcels, then re-screening every property against the current rules\u2026");
    try {
      const j = await (await fetch("/api/eligibility/rerun?market=lexington-ky", { method: "POST" })).json();
      say(j.error ? `\u274c ${j.error}` : `\u2705 ${j.checked} screened \u00b7 ${j.message} \u00b7 ${j.linked} parcel links \u00b7 ${(j.elapsedMs / 1000).toFixed(1)}s`);
      if (!j.error) await loadElig();
    } catch (e: any) { say(`\u274c ${e.message}`); } setBusy(null);
  }
  async function refreshListings() {
    setBusy("refresh");
    try {
      const j = await (await fetch("/api/listings/refresh", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ market: "lexington-ky", format: fmt, input: payload, fullSync }) })).json();
      if (j.error) say(`❌ ${j.error}`);
      else {
        say(`✅ ${j.received} received · ${j.message}`);
        say(`   ${j.qualified} pass the hard filters · ${j.needsHoaVerification} need HOA verification · ${j.rescreened} re-screened`);
        for (const c of (j.changes ?? []).slice(0, 12)) say(`   ${c.kind}: ${c.address ?? c.externalId} — ${c.reason}`);
        setPayload(""); await loadElig();
      }
    } catch (e: any) { say(`❌ ${e.message}`); } setBusy(null);
  }
  async function importSixgen() {
    if (!sixgenProps && !sixgenMonthly) return;
    setBusy("sixgen"); say("Loading the Sixgen portfolio export\u2026");
    try {
      const fd = new FormData();
      if (sixgenProps) fd.set("properties", sixgenProps);
      if (sixgenMonthly) fd.set("monthly", sixgenMonthly);
      const j = await (await fetch("/api/sixgen/import", { method: "POST", body: fd })).json();
      if (j.error) say(`\u274c ${j.error}`);
      else {
        say(`\u2705 ${j.propsWritten} listings \u00b7 ${j.monthsWritten} listing-months`);
        if (j.portfolio) say(`   T12: ${Number(j.portfolio.t12_revenue).toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 })} \u00b7 ${(Number(j.portfolio.occupancy) * 100).toFixed(1)}% occ \u00b7 $${Math.round(Number(j.portfolio.adr))} ADR`);
        for (const w of j.warnings ?? []) say(`   \u26a0 ${w}`);
        for (const e of j.parseErrors ?? []) say(`   \u2717 ${e}`);
      }
    } catch (e: any) { say(`\u274c ${e.message}`); } setBusy(null);
  }
  async function runForecasts() {
    setBusy("forecast"); say("Running the Sixgen comparable engine over every listing\u2026");
    try {
      const j = await (await fetch("/api/forecasts?market=lexington-ky", { method: "POST" })).json();
      say(j.error ? `\u274c ${j.error}` : `\u2705 ${j.message} \u00b7 model ${j.modelVersion ?? "\u2014"} \u00b7 ${(j.elapsedMs / 1000).toFixed(1)}s`);
    } catch (e: any) { say(`\u274c ${e.message}`); } setBusy(null);
  }
  async function invite() { if (!email.includes("@")) return; setBusy("invite");
    const j = await (await fetch("/api/invite", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, sendEmail: true }) })).json();
    say(j.error ? `❌ ${j.error}` : `✅ Invited ${j.email}${j.emailed ? " (email sent)" : ""}`); setEmail(""); await loadInvites(); setBusy(null); }
  async function revoke(e: string) { if (!confirm(`Revoke ${e}?`)) return; await fetch(`/api/invite?email=${encodeURIComponent(e)}`, { method: "DELETE" }); say(`Revoked ${e}`); loadInvites(); }

  return (
    <>
      <PageHeader title="Admin" subtitle="Data sources · rules · filters · weights · users" right={<Link href="/admin/rules"><Button variant="gold">STR Rules →</Button></Link>} />
      <div className="grid gap-4 p-6 lg:grid-cols-2">
        <Card><CardHeader title="1 · City GIS sync" subtitle="Pull LFUCG STR permits, match parcels, rebuild 600-ft exclusion in PostGIS" />
          <CardBody><Button onClick={refreshGis} disabled={busy !== null}>{busy === "gis" ? "Syncing…" : "Sync city data now"}</Button>
            <p className="mt-2 text-xs text-slate-500">Also callable by cron: <code>POST /api/refresh?jurisdiction=lfucg</code> with <code>Authorization: Bearer $IMPORT_SECRET</code>. For the ORR spreadsheet use the <Link href="/data/permits" className="text-blue-600 underline">permit import wizard</Link>.</p></CardBody></Card>

        <Card><CardHeader title="1b \u00b7 Re-run eligibility" subtitle="Re-screen every property: zoning treatment \u00b7 600-ft separation \u00b7 density \u00b7 HOA" right={elig ? <div className="flex gap-1">{(["GREEN", "YELLOW", "RED"] as const).map((c) => <Badge key={c} tone={c === "GREEN" ? "pass" : c === "YELLOW" ? "review" : "fail"}>{elig[c] ?? 0}</Badge>)}</div> : null} />
          <CardBody><Button onClick={rerunEligibility} disabled={busy !== null}>{busy === "elig" ? "Screening\u2026" : "Re-run eligibility now"}</Button>
            <p className="mt-2 text-xs text-slate-500">Run this after a rules change, a permit import, or a manual permit fix \u2014 every result stamps the <code>rules_version</code> it was decided under, so a stale screen is visible rather than silently re-interpreted.</p></CardBody></Card>

        <Card><CardHeader title="2 · 🔄 Refresh Lexington listings" subtitle="Diffs against what is stored: new · price change · relisted · removed, then re-screens what changed" />
          <CardBody>
            <div className="mb-2 flex gap-3 text-xs">{(["csv", "json"] as const).map((f) => <label key={f} className="flex items-center gap-1"><input type="radio" checked={fmt === f} onChange={() => setFmt(f)} />{f.toUpperCase()}</label>)}</div>
            <textarea value={payload} onChange={(e) => setPayload(e.target.value)} placeholder={fmt === "csv" ? "id,address,lat,lng,price,beds,baths,sqft,hoa,hoa_fee,status,url\n123,697 Cindy Blair Way 40503,37.9969,-84.5563,649900,4,4,2793,false,0,active,https://…" : '[{"id":"123","address":"697 Cindy Blair Way 40503","lat":37.9969,"lng":-84.5563,"price":649900,"beds":4}]'} className="mb-2 h-28 w-full rounded-lg border border-slate-300 p-2 font-mono text-[11px]" />
            <label className="mb-2 flex items-start gap-2 text-xs text-slate-600">
              <input type="checkbox" checked={fullSync} onChange={(e) => setFullSync(e.target.checked)} className="mt-0.5" />
              <span>This payload is the <b>complete</b> active set — mark anything missing from it as removed.
                <span className="block text-slate-400">Leave this off for a partial paste, or you will remove every listing it does not mention.</span></span>
            </label>
            <div className="flex items-center gap-3">
              <Button onClick={refreshListings} disabled={busy !== null || !payload.trim()}>{busy === "refresh" ? "Refreshing…" : fullSync ? "Run full refresh" : "Run partial refresh"}</Button>
              <Link href="/listings" className="text-xs text-blue-600 underline">All Listings →</Link>
            </div></CardBody></Card>

        <Card><CardHeader title="3 \u00b7 Sixgen performance + forecasts" subtitle="The comparable pool is Sixgen's own trailing-twelve results, not a market average" right={<Link href="/comps" className="text-xs text-blue-600 underline">Sixgen Comps \u2192</Link>} />
          <CardBody className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="block"><div className="mb-1 text-[11px] font-semibold text-slate-600">Properties file</div>
                <input type="file" accept=".csv,.xlsx" onChange={(e) => setSixgenProps(e.target.files?.[0] ?? null)} className="w-full text-xs" /></label>
              <label className="block"><div className="mb-1 text-[11px] font-semibold text-slate-600">Monthly performance file</div>
                <input type="file" accept=".csv,.xlsx" onChange={(e) => setSixgenMonthly(e.target.files?.[0] ?? null)} className="w-full text-xs" /></label>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={importSixgen} disabled={busy !== null || (!sixgenProps && !sixgenMonthly)}>{busy === "sixgen" ? "Importing\u2026" : "Import portfolio"}</Button>
              <Button variant="gold" onClick={runForecasts} disabled={busy !== null}>{busy === "forecast" ? "Modelling\u2026" : "Run forecasts"}</Button>
            </div>
            <p className="text-xs text-slate-500">The export in <code>data/sixgen/</code> is the expected shape. History is append-only \u2014 a re-import adds a new reading rather than overwriting, and the comp engine reads the newest one per month.</p>
          </CardBody></Card>

        <Card><CardHeader title="4 \u00b7 Who can log in" subtitle="Only invited emails can create an account" />
          <CardBody>
            <div className="mb-3 flex gap-2"><input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@company.com" className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm" /><Button onClick={invite} disabled={busy !== null}>Invite</Button></div>
            <div className="divide-y rounded-lg border">{(invites?.allowed ?? []).map((a: any) => { const p = invites.profiles.find((x: any) => x.email.toLowerCase() === a.email); return (
              <div key={a.email} className="flex items-center justify-between px-3 py-2 text-sm"><div><span className="font-medium">{a.email}</span>{p?.is_admin && <Badge tone="gold" className="ml-2">ADMIN</Badge>}<span className="ml-2 text-xs text-slate-500">{p ? "active" : "invited"}</span></div><button onClick={() => revoke(a.email)} className="text-xs text-red-600 hover:underline">Revoke</button></div>); })}
              {!invites?.allowed?.length && <div className="px-3 py-4 text-sm text-slate-500">No invites yet.</div>}</div></CardBody></Card>

        <Card><CardHeader title="5 · Configuration" subtitle="Everything legal or model-related is data, not code" />
          <CardBody className="space-y-2 text-sm">
            <Link href="/admin/rules" className="block rounded-lg border p-3 hover:bg-slate-50"><b>STR Rules</b> — spacing, density, zoning treatment, occupancy ceiling · versioned</Link>
            <div className="rounded-lg border p-3 opacity-70"><b>Acquisition filters</b> — 4+ bd · $400K+ · verified-no-HOA <Badge tone="neutral" className="ml-1">stored in app_settings · UI Phase 4</Badge></div>
            <div className="rounded-lg border p-3 opacity-70"><b>Ranking weights</b> — 8 factors, sum 1.00 <Badge tone="neutral" className="ml-1">seeded · UI Phase 6</Badge></div>
            <div className="rounded-lg border p-3 opacity-70"><b>Revenue model</b> — sixgen-comps-v1.1 <Badge tone="pass" className="ml-1">live</Badge></div>
          </CardBody></Card>
      </div>
      <div className="px-6 pb-6"><Card className="bg-slate-900 text-slate-100"><CardBody><div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Activity</div><div className="max-h-48 overflow-auto font-mono text-xs leading-relaxed">{log.length ? log.map((l, i) => <div key={i}>{l}</div>) : <span className="text-slate-500">No activity yet.</span>}</div></CardBody></Card></div>
    </>
  );
}
