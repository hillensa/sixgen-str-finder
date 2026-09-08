import * as React from "react";
export function Card({ className = "", ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={`rounded-xl border border-slate-200 bg-white shadow-sm ${className}`} {...p} />;
}
export function CardHeader({ title, subtitle, right }: { title: React.ReactNode; subtitle?: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-3.5">
      <div><div className="text-sm font-semibold text-slate-900">{title}</div>{subtitle && <div className="mt-0.5 text-xs text-slate-500">{subtitle}</div>}</div>
      {right}
    </div>
  );
}
export function CardBody({ className = "", ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={`px-5 py-4 ${className}`} {...p} />;
}
export function Stat({ label, value, hint, tone }: { label: string; value: React.ReactNode; hint?: string; tone?: "pass" | "review" | "fail" }) {
  const c = tone === "pass" ? "text-pass" : tone === "review" ? "text-review" : tone === "fail" ? "text-fail" : "text-slate-900";
  return (
    <div><div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-0.5 text-2xl font-bold ${c}`}>{value}</div>{hint && <div className="text-xs text-slate-500">{hint}</div>}</div>
  );
}
