import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 text-center shadow-sm">
        <div className="mb-1 text-[10px] font-bold uppercase tracking-[0.2em] text-gold">Sixgen STR Finder</div>
        <h1 className="text-lg font-bold text-navy">Page not found</h1>
        <p className="mt-2 text-sm text-slate-600">
          That address does not exist in this app. A property link may point at a listing that has since been removed.
        </p>
        <Link href="/dashboard" className="mt-4 inline-block rounded-lg bg-navy px-3.5 py-2 text-sm font-semibold text-white hover:bg-navy/90">
          Back to dashboard
        </Link>
      </div>
    </div>
  );
}
