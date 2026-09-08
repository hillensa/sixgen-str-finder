export default function Loading() {
  return (
    <div className="p-6">
      <div className="h-8 w-56 animate-pulse rounded bg-slate-200" />
      <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-xl border border-slate-200 bg-white" />
        ))}
      </div>
      <div className="mt-4 h-64 animate-pulse rounded-xl border border-slate-200 bg-white" />
    </div>
  );
}
