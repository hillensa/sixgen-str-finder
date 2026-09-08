import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient, audit } from "@/lib/supabase/admin";
import { computeProForma, amenityScenarios, assumptionsFrom, type ProFormaAssumptions } from "@/lib/proforma";
export const dynamic = "force-dynamic";

/**
 * GET /api/properties/:id
 * Everything the property page shows: candidate row, score breakdown, all three
 * forecast scenarios, the comps behind them, the eligibility check with its
 * reasons, price history, pro forma, pipeline and notes.
 */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const s = createClient();
  const { data: { user } } = await s.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const id = Number(params.id);
  if (!Number.isFinite(id)) return NextResponse.json({ error: "Bad property id" }, { status: 400 });

  const [{ data: detail, error }, { data: defaults }, { data: statuses }, { data: saved }] = await Promise.all([
    s.rpc("fn_property_detail", { p_property_id: id }),
    s.from("app_settings").select("value").eq("key", "proforma_defaults").maybeSingle(),
    s.from("app_settings").select("value").eq("key", "pipeline_statuses").maybeSingle(),
    s.from("saved_properties").select("property_id").eq("property_id", id).eq("user_id", user.id).maybeSingle(),
  ]);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  if (!detail?.candidate) return NextResponse.json({ error: "Property not found" }, { status: 404 });

  const c = detail.candidate;
  const stored = detail.proForma?.assumptions as ProFormaAssumptions | undefined;
  const assumptions = stored ?? assumptionsFrom(defaults?.value ?? null, {
    purchasePrice: Number(c.list_price ?? 0),
    annualRevenue: Number(c.forecast_revenue ?? 0),
    beds: c.beds ?? 0,
    occupancy: Number(c.forecast_occupancy ?? 0),
    hoaMonthly: c.hoa_fee_monthly,
  });

  const proForma = computeProForma(assumptions);
  return NextResponse.json({
    ...detail,
    assumptions,
    proFormaResult: proForma,
    amenityScenarios: amenityScenarios(assumptions),
    pipelineStatuses: statuses?.value ?? [],
    isSaved: !!saved,
    proFormaDefaults: defaults?.value ?? null,
  });
}

/**
 * POST /api/properties/:id
 * body: { action: 'proforma' | 'pipeline' | 'note' | 'save', ... }
 *
 * The pro forma is recomputed server-side from the submitted assumptions rather
 * than trusting the client's arithmetic — the stored `results` are what a later
 * reader will rely on.
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const s = createClient();
  const { data: { user } } = await s.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const id = Number(params.id);
  if (!Number.isFinite(id)) return NextResponse.json({ error: "Bad property id" }, { status: 400 });
  const body = await req.json().catch(() => null);
  if (!body?.action) return NextResponse.json({ error: "action is required" }, { status: 400 });

  const db = createAdminClient();
  const { data: property } = await db.from("properties").select("id").eq("id", id).maybeSingle();
  if (!property) return NextResponse.json({ error: "Property not found" }, { status: 404 });

  switch (body.action) {
    case "proforma": {
      const a = body.assumptions as ProFormaAssumptions;
      if (!a || typeof a.purchasePrice !== "number" || typeof a.annualRevenue !== "number") {
        return NextResponse.json({ error: "assumptions must include purchasePrice and annualRevenue." }, { status: 400 });
      }
      const results = computeProForma(a);
      const { data: existing } = await db.from("pro_formas").select("id").eq("property_id", id).eq("user_id", user.id).maybeSingle();
      const row = {
        property_id: id, user_id: user.id, name: body.name ?? "Base",
        assumptions: a, results, listing_price: Math.round(a.purchasePrice),
        is_default: true, updated_at: new Date().toISOString(),
      };
      const { error } = existing
        ? await db.from("pro_formas").update(row).eq("id", existing.id)
        : await db.from("pro_formas").insert(row);
      if (error) return NextResponse.json({ error: error.message }, { status: 400 });
      await audit(db, user.id, "proforma.save", "properties", id, { capRate: results.capRatePct, coc: results.cashOnCashPct });
      return NextResponse.json({ ok: true, results, amenityScenarios: amenityScenarios(a) });
    }

    case "pipeline": {
      const { data: statuses } = await db.from("app_settings").select("value").eq("key", "pipeline_statuses").maybeSingle();
      const allowed: string[] = statuses?.value ?? [];
      if (body.status && allowed.length && !allowed.includes(body.status)) {
        return NextResponse.json({ error: `Unknown status "${body.status}". Configured statuses: ${allowed.join(", ")}` }, { status: 400 });
      }
      const { data: current } = await db.from("acquisition_pipeline").select("status").eq("property_id", id).maybeSingle();
      const row: Record<string, any> = { property_id: id, updated_at: new Date().toISOString() };
      for (const k of ["status", "next_action", "follow_up_date", "offer_price", "broker_name", "broker_phone", "broker_email", "notes", "lost_reason"]) {
        if (body[k] !== undefined) row[k] = body[k] === "" ? null : body[k];
      }
      if (body.status && body.status !== current?.status) row.stage_changed_at = new Date().toISOString();
      if (body.assignToMe) row.assigned_to = user.id;

      const { data, error } = await db.from("acquisition_pipeline")
        .upsert(row, { onConflict: "property_id" }).select("*").single();
      if (error) return NextResponse.json({ error: error.message }, { status: 400 });
      await audit(db, user.id, "pipeline.update", "properties", id, { from: current?.status ?? null, to: data.status });
      return NextResponse.json({ ok: true, pipeline: data });
    }

    case "note": {
      const text = String(body.body ?? "").trim();
      if (!text) return NextResponse.json({ error: "A note cannot be empty." }, { status: 400 });
      const { data, error } = await s.from("property_notes").insert({ property_id: id, user_id: user.id, body: text }).select("*").single();
      if (error) return NextResponse.json({ error: error.message }, { status: 400 });
      return NextResponse.json({ ok: true, note: data });
    }

    case "save": {
      if (body.saved === false) {
        const { error } = await s.from("saved_properties").delete().eq("property_id", id).eq("user_id", user.id);
        if (error) return NextResponse.json({ error: error.message }, { status: 400 });
        return NextResponse.json({ ok: true, isSaved: false });
      }
      const { error } = await s.from("saved_properties").upsert({ property_id: id, user_id: user.id }, { onConflict: "user_id,property_id" });
      if (error) return NextResponse.json({ error: error.message }, { status: 400 });
      return NextResponse.json({ ok: true, isSaved: true });
    }

    default:
      return NextResponse.json({ error: `Unknown action "${body.action}"` }, { status: 400 });
  }
}
