"use client";
import { useEffect, useMemo, useState } from "react";
import PageHeader from "@/components/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { filterSignature, type ZillowCriteria } from "@/lib/zillow/criteria";
import { parsePayload, mergePayloads, isComplete, matchesCriteria, type ZillowPayload } from "@/lib/zillow/payload";
import { bookmarkletHref } from "@/lib/zillow/bookmarklet";

const STORE = "sixgen-zillow-collected";
const OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8];

type Step = { label: string; state: "running" | "done" | "error"; detail?: string };

/**
 * Pull the Zillow search on demand.
 *
 * Zillow blocks automated pulls, so this does not fetch Zillow itself. The
 * button opens the saved search in Seth's own browser; the "Send to Sixgen"
 * bookmark copies each results page; pasting here collects them; Import runs
 * them through the normal refresh, then re-forecasts and re-ranks.
 */
export default function ZillowPull() {
  const [criteria, setCriteria] = useState<ZillowCriteria | null>(null);
  const [saved, setSaved] = useState<ZillowCriteria | null>(null);
  const [msg, setMsg] = useState<{ tone: "pass" | "fail" | "info"; text: string } | null>(null);
  const [collected, setCollected] = useState<ZillowPayload | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [busy, setBusy] = useState(false);
  const [href, setHref] = useState("#");

  useEffect(() => {
    fetch("/api/zillow/criteria").then((r) => r.json()).then((j) => { setCriteria(j.criteria); setSaved(j.criteria); })
      .catch(() => setMsg({ tone: "fail", text: "Could not load the saved search." }));
    // client-only: the javascript: URL is assembled after mount so React never
    // renders it server-side as a link attribute
    setHref(bookmarkletHref());
    try { const s = sessionStorage.getItem(STORE); if (s) { const p = parsePayload(s); if (p.ok) setCollected(p.value); } } catch { /* storage blocked */ }
  }, []);

  // Paste anywhere on the page.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const t = e.clipboardData?.getData("text") ?? "";
      if (!t.includes("zillow-pull")) return;          // let ordinary pastes through
      e.preventDefault();
      take(t);
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  });

  function take(text: string) {
    const p = parsePayload(text);
    if (!p.ok) { setMsg({ tone: "fail", text: p.error }); return; }
    const next = mergePayloads(collected, p.value);
    setCollected(next);
    try { sessionStorage.setItem(STORE, JSON.stringify(next)); } catch { /* storage blocked */ }
    setSteps([]);
    setMsg({ tone: "info", text: `Pasted page ${p.value.pages.join(", ")} — ${next.homes.length} home${next.homes.length === 1 ? "" : "s"} collected${p.dropped ? ` (${p.dropped} malformed row${p.dropped === 1 ? "" : "s"} skipped)` : ""}.` });
  }

  function clear() {
    setCollected(null); setSteps([]); setMsg(null);
    try { sessionStorage.removeItem(STORE); } catch { /* storage blocked */ }
  }

  const dirty = !!criteria && !!saved && (criteria.bedsMin !== saved.bedsMin || criteria.bathsMin !== saved.bathsMin);

  async function save(): Promise<ZillowCriteria | null> {
    if (!criteria) return null;
    const r = await fetch("/api/zillow/criteria", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(criteria) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { setMsg({ tone: "fail", text: j.error ?? "Could not save the search." }); return null; }
    setSaved(j.criteria);
    return j.criteria;
  }

  async function pull() {
    // Open the tab inside the click, before any await, or the browser treats
    // it as a pop-up and blocks it. Its address is set once the save lands.
    const tab = window.open("about:blank", "_blank");
    const c = dirty ? await save() : saved;
    if (!c) { tab?.close(); return; }
    const j = await (await fetch("/api/zillow/criteria")).json();
    if (tab) tab.location.href = j.url; else window.location.href = j.url;
    if (collected && collected.signature !== filterSignature(c)) clear();
    setMsg({ tone: "info", text: "Zillow is open in a new tab. Click the Send to Sixgen bookmark on each results page, and paste each one here." });
  }

  async function runImport() {
    if (!collected) return;
    setBusy(true); setMsg(null);
    const set = (i: number, s: Step) => setSteps((prev) => { const n = [...prev]; n[i] = s; return n; });
    setSteps([{ label: "Importing homes", state: "running" }]);
    try {
      const r = await fetch("/api/zillow/import", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ payload: collected }) });
      const j = await r.json();
      if (!r.ok) { set(0, { label: "Importing homes", state: "error", detail: j.error }); return; }
      const c = j.counts ?? {};
      set(0, { label: "Importing homes", state: "done",
        detail: `${c.new ?? 0} new · ${c.price_change ?? 0} price changes · ${c.unchanged ?? 0} unchanged`
          + (j.complete ? ` · ${c.removed ?? 0} no longer listed` : " · partial pull, nothing retired")
          + (j.rejectedByCriteria ? ` · ${j.rejectedByCriteria} below the bed/bath minimums skipped` : "") });

      set(1, { label: "Forecasting revenue", state: "running" });
      const f = await (await fetch("/api/forecasts?market=lexington-ky", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json();
      set(1, { label: "Forecasting revenue", state: f.error ? "error" : "done", detail: f.error ?? f.message });

      set(2, { label: "Re-ranking", state: "running" });
      const sc = await (await fetch("/api/scores?market=lexington-ky", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json();
      set(2, { label: "Re-ranking", state: sc.error ? "error" : "done", detail: sc.error ?? sc.message });

      if (!f.error && !sc.error) {
        try { sessionStorage.removeItem(STORE); } catch { /* storage blocked */ }
        setCollected(null);
        setMsg({ tone: "pass", text: "Done. The map and Top 25 now reflect this pull." });
      }
    } catch (e) {
      setMsg({ tone: "fail", text: `Import failed: ${(e as Error).message}` });
    } finally { setBusy(false); }
  }

  const complete = collected ? isComplete(collected) : false;
  const mismatch = !!collected && !!saved && !matchesCriteria(collected, saved);
  const missing = useMemo(() => {
    if (!collected?.totalPages) return [];
    const out: number[] = [];
    for (let i = 1; i <= collected.totalPages; i++) if (!collected.pages.includes(i)) out.push(i);
    return out;
  }, [collected]);

  return (
    <>
      <PageHeader title="Zillow Pull" subtitle="Re-pull Lexington homes for sale from Zillow, on demand. The same search runs automatically every Monday." />
      <div className="grid gap-4 p-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="1 · Search" subtitle="Lexington, KY · for sale · no HOA" />
          <CardBody className="space-y-4 text-sm">
            <div className="grid grid-cols-2 gap-3">
              {(["bedsMin", "bathsMin"] as const).map((k) => (
                <label key={k} className="block">
                  <span className="text-xs font-semibold text-slate-600">{k === "bedsMin" ? "Bedrooms, at least" : "Bathrooms, at least"}</span>
                  <select
                    value={criteria?.[k] ?? ""}
                    disabled={!criteria}
                    onChange={(e) => criteria && setCriteria({ ...criteria, [k]: Number(e.target.value) })}
                    className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  >
                    {OPTIONS.map((n) => <option key={n} value={n}>{n}+</option>)}
                  </select>
                </label>
              ))}
            </div>
            <p className="text-[11px] text-slate-500">
              HOA is held at $0. Zillow counts homes with no HOA data as $0, so these still import as
              &ldquo;HOA unverified&rdquo; — nothing from a listing site is treated as proof of no HOA.
              {dirty && <b className="text-amber-700"> Unsaved — pulling will save it, and Monday&apos;s automatic pull will use it too.</b>}
            </p>
            <button onClick={pull} disabled={!criteria} className="w-full rounded-lg bg-navy px-4 py-3 text-sm font-bold text-white hover:bg-navy/90 disabled:opacity-50">
              🔄 Pull from Zillow
            </button>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="2 · One-time setup" subtitle="A bookmark that sends a Zillow results page here" />
          <CardBody className="space-y-3 text-sm">
            <p>Drag this button onto your bookmarks bar <span className="text-slate-500">(Ctrl+Shift+B shows the bar)</span>:</p>
            {/* eslint-disable-next-line react/jsx-no-script-url */}
            <a
              href={href}
              onClick={(e) => { e.preventDefault(); setMsg({ tone: "info", text: "Drag that button to your bookmarks bar — it only works when clicked on a Zillow page." }); }}
              className="inline-block cursor-grab rounded-lg border-2 border-dashed border-gold bg-amber-50 px-4 py-2 font-bold text-navy"
            >
              📋 Send to Sixgen
            </a>
            <ol className="list-decimal space-y-1 pl-5 text-xs text-slate-600">
              <li>Click <b>Pull from Zillow</b>. Zillow opens in a new tab with your search.</li>
              <li>Click the <b>Send to Sixgen</b> bookmark. It copies that page&apos;s homes.</li>
              <li>Come back here and press <b>Ctrl+V</b>.</li>
              <li>On Zillow, go to the next page and repeat until every page is collected.</li>
              <li>Click <b>Import</b>.</li>
            </ol>
            <p className="text-[11px] text-slate-500">
              It reads only the page you are looking at and sends nothing anywhere; the clipboard is the only way out.
            </p>
          </CardBody>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader
            title="3 · Collected"
            subtitle={collected ? `Search: ${collected.signature ?? "unknown filters"}` : "Paste here (Ctrl+V) after clicking the bookmark on Zillow"}
            right={collected ? <Badge tone={complete ? "pass" : "review"}>{complete ? "COMPLETE" : "PARTIAL"}</Badge> : undefined}
          />
          <CardBody className="space-y-3 text-sm">
            {msg && (
              <div className={`rounded-lg p-3 text-xs ${msg.tone === "fail" ? "bg-red-50 text-red-800" : msg.tone === "pass" ? "bg-green-50 text-green-800" : "bg-slate-50 text-slate-700"}`}>{msg.text}</div>
            )}

            {!collected ? (
              <textarea
                placeholder="Press Ctrl+V anywhere on this page, or paste here."
                onPaste={(e) => { e.preventDefault(); take(e.clipboardData.getData("text")); }}
                className="h-24 w-full rounded-lg border-2 border-dashed border-slate-300 p-3 text-xs"
              />
            ) : (
              <>
                <div className="grid grid-cols-3 gap-3 text-center">
                  <Stat k="Homes" v={`${collected.homes.length}${collected.total != null ? ` of ${collected.total}` : ""}`} />
                  <Stat k="Pages" v={`${collected.pages.length}${collected.totalPages != null ? ` of ${collected.totalPages}` : ""}`} />
                  <Stat k="With photos" v={String(collected.homes.filter((h) => h.photo).length)} />
                </div>
                {mismatch && (
                  <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800">
                    These came from a Zillow search with different filters ({collected.signature ?? "unknown"}) than the saved
                    search ({saved ? filterSignature(saved) : "—"}). Import will refuse them. Clear, then use Pull from Zillow.
                  </div>
                )}
                {!complete && !mismatch && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                    {missing.length ? `Still missing page${missing.length === 1 ? "" : "s"} ${missing.join(", ")}. ` : ""}
                    You can import now, but a partial pull only adds and updates homes. Homes that have sold or left the
                    search are retired only by a complete pull.
                  </div>
                )}
                <div className="flex gap-2">
                  <button onClick={runImport} disabled={busy || mismatch} className="flex-1 rounded-lg bg-navy px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50">
                    {busy ? "Importing…" : `Import ${collected.homes.length} homes${complete ? "" : " (partial)"}`}
                  </button>
                  <button onClick={clear} disabled={busy} className="rounded-lg border border-slate-300 px-4 py-2.5 text-sm">Clear</button>
                </div>
              </>
            )}

            {steps.length > 0 && (
              <div className="space-y-1.5 border-t pt-3">
                {steps.map((s, i) => s && (
                  <div key={i} className="text-xs">
                    <span className="mr-2">{s.state === "running" ? "⏳" : s.state === "done" ? "✅" : "❌"}</span>
                    <b>{s.label}</b>{s.detail && <span className="text-slate-600"> — {s.detail}</span>}
                  </div>
                ))}
              </div>
            )}
          </CardBody>
        </Card>
      </div>
    </>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="rounded-lg bg-slate-50 p-3">
      <div className="text-lg font-bold text-navy">{v}</div>
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{k}</div>
    </div>
  );
}
