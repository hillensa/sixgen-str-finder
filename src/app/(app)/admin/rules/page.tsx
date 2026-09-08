"use client";
import { useEffect, useState } from "react";
import PageHeader from "@/components/PageHeader";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { StrRule } from "@/lib/types";
import { RULE_KEYS, ZONING_TREATMENTS } from "@/lib/rules";

const empty = { rule_key: "spacing_ft", rule_name: "", value_num: "", value_text: "", applicable_zoning: "", applicable_str_type: "unhosted", effective_date: new Date().toISOString().slice(0, 10), end_date: "", enabled: true, source: "", notes: "", rules_version: "" };

export default function RulesPage() {
  const [rules, setRules] = useState<StrRule[]>([]); const [form, setForm] = useState<any>(empty); const [msg, setMsg] = useState<string | null>(null);
  const load = () => fetch("/api/rules?jurisdiction=lfucg").then((r) => r.json()).then((d) => setRules(d.rules ?? []));
  useEffect(() => { load(); }, []);
  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));
  async function save() {
    const j = await (await fetch("/api/rules", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...form, jurisdiction_id: "lfucg" }) })).json();
    setMsg(j.error ? `❌ ${j.error}` : `✅ Saved ${j.rule.rule_name}`); if (!j.error) { setForm(empty); load(); }
  }
  async function toggle(r: StrRule) { await fetch("/api/rules", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...r, enabled: !r.enabled }) }); load(); }
  async function remove(r: StrRule) { if (!confirm(`Delete "${r.rule_name}"? Prefer disabling to preserve history.`)) return; await fetch(`/api/rules?id=${r.id}`, { method: "DELETE" }); load(); }
  const edit = (r: StrRule) => setForm({ ...r, value_num: r.value_num ?? "", value_text: r.value_text ?? "", applicable_zoning: (r.applicable_zoning ?? []).join(", "), end_date: r.end_date ?? "", source: r.source ?? "", notes: r.notes ?? "" });
  const isText = form.rule_key === "zoning_treatment";

  return (
    <>
      <PageHeader title="STR Rules — Lexington-Fayette (LFUCG)" subtitle="Regulations are data. Every analysis records the rules version it used." right={<Badge tone="gold">{rules[0]?.rules_version ?? "—"}</Badge>} />
      <div className="grid gap-4 p-6 xl:grid-cols-[1fr_380px]">
        <Card>
          <CardHeader title="Active rule set" subtitle="Disabled rules are kept for history and can be re-enabled" />
          <CardBody className="overflow-x-auto p-0">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-left text-slate-500"><tr><th className="px-4 py-2">Rule</th><th>Value</th><th>Zoning</th><th>Type</th><th>Effective</th><th>Status</th><th>Source</th><th></th></tr></thead>
              <tbody>{rules.map((r) => (
                <tr key={r.id} className="border-t border-slate-100 align-top">
                  <td className="px-4 py-2"><div className="font-semibold">{r.rule_name}</div><code className="text-[10px] text-slate-500">{r.rule_key}</code>{r.notes && <div className="mt-0.5 max-w-xs text-[11px] text-slate-500">{r.notes}</div>}</td>
                  <td className="py-2 pr-3 font-mono">{r.value_num ?? r.value_text ?? <span className="text-amber-700">blank</span>}</td>
                  <td className="py-2 pr-3 max-w-[160px]">{r.applicable_zoning?.length ? r.applicable_zoning.join(", ") : <span className="text-slate-400">all</span>}</td>
                  <td className="py-2 pr-3">{r.applicable_str_type ?? "both"}</td>
                  <td className="py-2 pr-3">{r.effective_date}{r.end_date ? ` → ${r.end_date}` : ""}</td>
                  <td className="py-2 pr-3"><Badge tone={r.enabled ? "pass" : "neutral"}>{r.enabled ? "enabled" : "disabled"}</Badge></td>
                  <td className="py-2 pr-3 max-w-[160px] text-[11px] text-slate-500">{r.source}</td>
                  <td className="py-2 pr-4 whitespace-nowrap"><button onClick={() => edit(r)} className="text-blue-600 hover:underline">edit</button> · <button onClick={() => toggle(r)} className="text-slate-600 hover:underline">{r.enabled ? "disable" : "enable"}</button> · <button onClick={() => remove(r)} className="text-red-600 hover:underline">delete</button></td>
                </tr>))}</tbody>
            </table>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title={form.id ? "Edit rule" : "Add rule"} subtitle="Changing a value creates a new effective version — don't overwrite history for a changed ordinance; add a new row with a later effective date." />
          <CardBody className="space-y-2 text-sm">
            <label className="block text-xs">Rule key<select value={form.rule_key} onChange={(e) => set("rule_key", e.target.value)} className="mt-0.5 w-full rounded border px-2 py-1.5">{RULE_KEYS.map((k) => <option key={k}>{k}</option>)}</select></label>
            <label className="block text-xs">Name<input value={form.rule_name} onChange={(e) => set("rule_name", e.target.value)} className="mt-0.5 w-full rounded border px-2 py-1.5" /></label>
            {isText ? (
              <label className="block text-xs">Treatment<select value={form.value_text} onChange={(e) => set("value_text", e.target.value)} className="mt-0.5 w-full rounded border px-2 py-1.5"><option value="">—</option>{ZONING_TREATMENTS.map((t) => <option key={t} value={t}>{t}</option>)}</select></label>
            ) : (
              <label className="block text-xs">Numeric value<input type="number" step="any" value={form.value_num} onChange={(e) => set("value_num", e.target.value)} className="mt-0.5 w-full rounded border px-2 py-1.5" /></label>
            )}
            <label className="block text-xs">Applicable zoning (comma-separated, blank = all)<input value={form.applicable_zoning} onChange={(e) => set("applicable_zoning", e.target.value)} placeholder="R-1A, R-1B" className="mt-0.5 w-full rounded border px-2 py-1.5" /></label>
            <label className="block text-xs">STR type<select value={form.applicable_str_type ?? ""} onChange={(e) => set("applicable_str_type", e.target.value)} className="mt-0.5 w-full rounded border px-2 py-1.5"><option value="">both</option><option value="unhosted">unhosted</option><option value="hosted">hosted</option></select></label>
            <div className="grid grid-cols-2 gap-2"><label className="block text-xs">Effective<input type="date" value={form.effective_date} onChange={(e) => set("effective_date", e.target.value)} className="mt-0.5 w-full rounded border px-2 py-1.5" /></label><label className="block text-xs">End (optional)<input type="date" value={form.end_date} onChange={(e) => set("end_date", e.target.value)} className="mt-0.5 w-full rounded border px-2 py-1.5" /></label></div>
            <label className="block text-xs">Source / citation<input value={form.source} onChange={(e) => set("source", e.target.value)} className="mt-0.5 w-full rounded border px-2 py-1.5" /></label>
            <label className="block text-xs">Notes<textarea value={form.notes} onChange={(e) => set("notes", e.target.value)} className="mt-0.5 h-16 w-full rounded border px-2 py-1.5" /></label>
            <label className="block text-xs">Rules version (blank = auto)<input value={form.rules_version} onChange={(e) => set("rules_version", e.target.value)} placeholder="v2026.09" className="mt-0.5 w-full rounded border px-2 py-1.5" /></label>
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={!!form.enabled} onChange={(e) => set("enabled", e.target.checked)} />Enabled</label>
            <div className="flex gap-2 pt-1"><Button onClick={save}>{form.id ? "Save changes" : "Add rule"}</Button>{form.id && <Button variant="secondary" onClick={() => setForm(empty)}>Cancel</Button>}</div>
            {msg && <div className="text-xs">{msg}</div>}
          </CardBody>
        </Card>
      </div>
    </>
  );
}
