import * as React from "react";
type T = "pass" | "review" | "fail" | "neutral" | "info" | "gold";
const t: Record<T, string> = {
  pass: "bg-green-100 text-green-800", review: "bg-amber-100 text-amber-800", fail: "bg-red-100 text-red-800",
  neutral: "bg-slate-100 text-slate-700", info: "bg-blue-100 text-blue-800", gold: "bg-gold/20 text-amber-900",
};
export function Badge({ tone = "neutral", children, className = "" }: { tone?: T; children: React.ReactNode; className?: string }) {
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${t[tone]} ${className}`}>{children}</span>;
}
export function classificationTone(c?: string | null): T { return c === "GREEN" ? "pass" : c === "YELLOW" ? "review" : c === "RED" ? "fail" : "neutral"; }
export function resultTone(r?: string | null): T { return r === "PASS" ? "pass" : r === "FAIL" ? "fail" : r === "REVIEW" || r === "DATA_REQUIRED" ? "review" : "neutral"; }
