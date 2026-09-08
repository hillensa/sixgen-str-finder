"use client";
import Link from "next/link";
import { Button } from "@/components/ui/button";

/**
 * What a user sees when something breaks.
 *
 * Two rules here, both deliberate for a tool that produces legal screens:
 *  · Never imply the app is still working. A half-rendered page with a stale
 *    number on it is worse than an honest failure.
 *  · Show the digest. Next.js hashes the server error and logs the detail
 *    server-side; without the digest on screen nobody can connect a user's
 *    report to the log line.
 */
export default function ErrorState({
  error, reset, title = "Something went wrong",
}: {
  error: Error & { digest?: string };
  reset?: () => void;
  title?: string;
}) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.2em] text-gold">Sixgen STR Finder</div>
        <h1 className="text-lg font-bold text-navy">{title}</h1>
        <p className="mt-2 text-sm text-slate-600">
          This page could not be loaded. Nothing was saved, and no screening result on this page should be relied on.
        </p>

        <p className="mt-3 rounded-lg bg-slate-50 p-3 font-mono text-[11px] leading-relaxed text-slate-600">
          {error.message || "No error message was provided."}
          {error.digest && <span className="mt-1 block text-slate-400">digest {error.digest}</span>}
        </p>

        <div className="mt-4 flex flex-wrap gap-2">
          {reset && <Button onClick={reset}>Try again</Button>}
          <Link href="/dashboard"><Button variant="secondary">Back to dashboard</Button></Link>
        </div>

        <p className="mt-4 text-[11px] text-slate-500">
          If this keeps happening, check Admin &rarr; Activity and the <code>data_errors</code> table before re-running an import.
        </p>
      </div>
    </div>
  );
}
