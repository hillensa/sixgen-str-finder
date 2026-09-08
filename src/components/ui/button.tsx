import * as React from "react";
type V = "primary" | "secondary" | "ghost" | "danger" | "gold";
const styles: Record<V, string> = {
  primary: "bg-navy text-white hover:bg-navy/90", secondary: "bg-slate-100 text-slate-800 hover:bg-slate-200",
  ghost: "bg-transparent hover:bg-slate-100", danger: "bg-red-600 text-white hover:bg-red-700", gold: "bg-gold text-navy hover:brightness-105",
};
export function Button({ variant = "primary", className = "", ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: V }) {
  return <button className={`inline-flex items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${styles[variant]} ${className}`} {...p} />;
}
