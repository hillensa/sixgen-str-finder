export default function PageHeader({ title, subtitle, right }: { title: string; subtitle?: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-slate-200 bg-white px-6 py-4">
      <div><h1 className="text-lg font-bold text-navy">{title}</h1>{subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}</div>
      {right}
    </div>
  );
}
export function PhaseStub({ phase, title, items }: { phase: number; title: string; items: string[] }) {
  return (
    <div className="m-6 rounded-xl border-2 border-dashed border-slate-300 bg-white p-8 text-center">
      <div className="mx-auto mb-2 inline-block rounded-full bg-gold/20 px-3 py-1 text-xs font-bold text-amber-900">Phase {phase}</div>
      <h2 className="text-base font-semibold text-slate-800">{title}</h2>
      <ul className="mx-auto mt-3 max-w-md space-y-1 text-left text-sm text-slate-600">{items.map((i) => <li key={i}>• {i}</li>)}</ul>
      <p className="mt-4 text-xs text-slate-400">Database tables and API scaffolding for this area already exist; the UI ships in this phase.</p>
    </div>
  );
}
