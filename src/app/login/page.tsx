"use client";
import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";

export default function LoginPage() {
  const [email, setEmail] = useState(""); const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null); const [loading, setLoading] = useState(false);
  async function signIn(e: React.FormEvent) {
    e.preventDefault(); setLoading(true); setError(null);
    const { error } = await createClient().auth.signInWithOtp({ email: email.trim().toLowerCase(), options: { emailRedirectTo: `${window.location.origin}/auth/callback`, shouldCreateUser: true } });
    setLoading(false); if (error) setError(error.message); else setSent(true);
  }
  return (
    <main className="flex min-h-screen items-center justify-center bg-navy px-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-xl">
        <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.2em] text-gold">Sixgen Rentals</div>
        <h1 className="mb-1 text-2xl font-bold text-navy">STR Finder</h1>
        <p className="mb-6 text-sm text-slate-600">Private access. Sign in with your invited email and we&apos;ll send a one-time link.</p>
        {sent ? (
          <div className="rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-900"><b>Check your email.</b> We sent a sign-in link to {email}.</div>
        ) : (
          <form onSubmit={signIn} className="space-y-4">
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com"
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-navy focus:ring-2 focus:ring-navy/20" />
            {error && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error.includes("not invited") ? "That email hasn't been invited yet. Ask your administrator to add you." : error}</div>}
            <Button type="submit" disabled={loading} className="w-full">{loading ? "Sending…" : "Email me a sign-in link"}</Button>
          </form>
        )}
      </div>
    </main>
  );
}
