"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: "▦" },
  { href: "/map", label: "Map", icon: "◎" },
  { href: "/top25", label: "Top 25", icon: "🏆" },
  { href: "/listings", label: "All Listings", icon: "☰" },
  { href: "/test-address", label: "Test Address", icon: "⌖" },
  { href: "/pipeline", label: "Pipeline", icon: "⇥" },
  { href: "/comps", label: "Sixgen Comps", icon: "≋" },
  { href: "/data", label: "Data", icon: "⇪" },
  { href: "/data/permits", label: "Permit Import", icon: "⤓", admin: true },
  { href: "/admin", label: "Admin", icon: "⚙", admin: true },
];

export default function AppShell({ children, email, isAdmin, marketName }: { children: React.ReactNode; email: string; isAdmin: boolean; marketName: string }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);

  // a navigation should never leave the drawer covering the page it opened
  useEffect(() => { setOpen(false); }, [path]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, []);

  async function signOut() { await createClient().auth.signOut(); window.location.href = "/login"; }

  const items = NAV.filter((n) => !n.admin || isAdmin);
  const isActive = (href: string) =>
    // /data must not light up while /data/permits is open
    path === href || (path.startsWith(href + "/") && !items.some((n) => n.href !== href && n.href.startsWith(href + "/") && path.startsWith(n.href)));

  const nav = (
    <nav className="flex-1 space-y-0.5 overflow-y-auto px-3">
      {items.map((n) => (
        <Link key={n.href} href={n.href}
          aria-current={isActive(n.href) ? "page" : undefined}
          className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition ${isActive(n.href) ? "bg-white/15 font-semibold" : "text-white/80 hover:bg-white/10"}`}>
          <span className="w-4 text-center text-xs opacity-80" aria-hidden>{n.icon}</span>{n.label}
        </Link>
      ))}
    </nav>
  );

  const brand = (
    <div className="px-5 pb-3 pt-5">
      <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-gold">Sixgen Rentals</div>
      <div className="text-base font-bold leading-tight">STR Finder</div>
      <div className="mt-1 text-[11px] text-white/60">{marketName}</div>
    </div>
  );

  const footer = (
    <div className="border-t border-white/10 px-5 py-3 text-[11px] text-white/70">
      <div className="truncate">{email}</div>
      <button onClick={signOut} className="mt-1 text-gold hover:underline">Sign out</button>
    </div>
  );

  return (
    <div className="flex h-screen bg-slate-50">
      {/* desktop rail */}
      <aside className="hidden w-56 shrink-0 flex-col bg-navy text-white lg:flex">
        {brand}{nav}{footer}
      </aside>

      {/* mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 bg-slate-900/50" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-64 flex-col bg-navy text-white shadow-xl">
            <div className="flex items-start justify-between">
              {brand}
              <button onClick={() => setOpen(false)} aria-label="Close navigation" className="px-4 pt-5 text-white/70 hover:text-white">✕</button>
            </div>
            {nav}{footer}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* mobile top bar */}
        <div className="flex items-center gap-3 border-b border-slate-200 bg-navy px-4 py-2.5 text-white lg:hidden">
          <button onClick={() => setOpen(true)} aria-label="Open navigation" aria-expanded={open} className="rounded p-1 text-xl leading-none hover:bg-white/10">☰</button>
          <div className="min-w-0">
            <div className="text-sm font-bold leading-tight">STR Finder</div>
            <div className="truncate text-[10px] text-white/60">{marketName}</div>
          </div>
        </div>

        <main className="min-h-0 flex-1 overflow-auto">{children}</main>

        <footer className="border-t border-amber-200 bg-amber-50 px-4 py-1.5 text-[11px] leading-snug text-amber-900">
          Sixgen STR Finder is an acquisition-screening tool. Final STR eligibility must be confirmed with Lexington-Fayette Urban County Government Planning and applicable legal professionals.
        </footer>
      </div>
    </div>
  );
}
