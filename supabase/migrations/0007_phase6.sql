-- ============================================================================
--  Phase 6 — Top 25 & Underwriting
--
--  Eligibility is a GATE, not a factor. A property that fails a rule this tool
--  can evaluate does not get a good score with a warning attached — it is not
--  ranked at all, and appears in the "Requires Review" list with its reason.
--  Everything that survives the gate is then scored on weighted factors read
--  from `scoring_weights`, so the ranking is configuration rather than code.
--
--  Run in Supabase SQL Editor after 0006. Idempotent.
-- ============================================================================

-- ───────────────────────── pipeline shape ───────────────────────────────────
alter table acquisition_pipeline add column if not exists stage_changed_at timestamptz not null default now();
alter table acquisition_pipeline add column if not exists lost_reason      text;
alter table acquisition_pipeline add column if not exists notes            text;
create index if not exists pipeline_status_idx on acquisition_pipeline(status, updated_at desc);

-- Statuses are data, like every other business rule here.
insert into app_settings (key, value) values
  ('pipeline_statuses', '["New","Researching","Contacted","Offer Prepared","Offer Submitted","Under Contract","Closed","Passed"]'::jsonb)
on conflict (key) do nothing;
insert into app_settings (key, value) values
  ('proforma_defaults', '{
     "management_pct": 0.20, "cleaning_per_stay": 175, "avg_stay_nights": 3,
     "utilities_monthly": 350, "internet_monthly": 90, "lawn_snow_monthly": 150,
     "supplies_pct": 0.03, "repairs_pct": 0.04, "insurance_annual": 3200,
     "tax_rate_pct": 1.05, "hoa_monthly": 0, "furnishing_per_bedroom": 9000,
     "down_payment_pct": 0.25, "interest_rate_pct": 7.0, "loan_years": 30,
     "closing_cost_pct": 0.03
   }'::jsonb)
on conflict (key) do nothing;

alter table pro_formas add column if not exists listing_price bigint;
alter table pro_formas add column if not exists is_default    boolean not null default false;
create index if not exists proforma_property_idx on pro_formas(property_id, updated_at desc);

alter table acquisition_scores add column if not exists rank            int;
alter table acquisition_scores add column if not exists gated           boolean not null default false;
alter table acquisition_scores add column if not exists gate_reason     text;
alter table acquisition_scores add column if not exists unavailable_factors text[];

-- ───────────────────────── one read for the scorer ──────────────────────────
-- Listing, property, eligibility and the base forecast in a single row. The
-- scorer needs the whole candidate pool at once because several factors are
-- relative (a yield is only good compared to the other yields on offer).
drop view if exists v_acquisition_candidates;
create view v_acquisition_candidates with (security_invoker = true) as
  select
    l.property_id, l.listing_id, l.market_id, l.external_id, l.provider,
    l.status, l.list_price, l.price_drop_pct, l.days_on_market, l.url,
    l.primary_photo, l.brokerage, l.agent, l.first_seen, l.listed_at,
    l.address, l.unit, l.zip, l.lat, l.lng,
    l.beds, l.baths, l.sqft, l.lot_sqft, l.year_built, l.property_type,
    l.garage, l.pool, l.basement, l.finished_basement,
    l.hoa_status, l.hoa_fee_monthly, l.price_per_sqft,
    l.classification, l.eligibility_summary, l.zone_code, l.zoning_treatment,
    l.cup_required, l.spacing_result, l.nearest_str_distance_ft, l.density_result,
    l.rules_version, l.eligibility_checked_at,
    f.annual_revenue        as forecast_revenue,
    f.adr                   as forecast_adr,
    f.occupancy             as forecast_occupancy,
    f.confidence            as forecast_confidence,
    f.comp_count, f.comp_coverage, f.model_version, f.monthly as forecast_monthly,
    f.gross_yield_pct,
    lo.annual_revenue       as forecast_low,
    hi.annual_revenue       as forecast_high,
    (select count(*) from saved_properties sp where sp.property_id = l.property_id) as save_count,
    pl.status               as pipeline_status,
    pl.updated_at           as pipeline_updated_at
  from v_listings_enriched l
  left join v_property_forecast f  on f.property_id = l.property_id and f.scenario = 'base'
  left join v_property_forecast lo on lo.property_id = l.property_id and lo.scenario = 'conservative'
  left join v_property_forecast hi on hi.property_id = l.property_id and hi.scenario = 'upside'
  left join acquisition_pipeline pl on pl.property_id = l.property_id
  where l.removed_at is null;

/** The scoring weights in force for a market, normalized to sum to 1. */
create or replace function fn_scoring_weights(p_market text)
returns table (factor_key text, factor_name text, weight numeric)
language sql stable as $$
  with w as (
    select s.factor_key, s.factor_name, s.weight
      from scoring_weights s
     where s.market_id = p_market and s.enabled and s.weight > 0
  ), t as (select coalesce(sum(weight), 0) as total from w)
  select w.factor_key, w.factor_name,
         case when (select total from t) > 0
              then round(w.weight / (select total from t), 6) else 0 end
    from w order by 3 desc, 1;
$$;

/**
 * Sixgen's own listings as demand evidence: locations the portfolio has already
 * proven, weighted by what they earn. Used for the location factor — the app has
 * no third-party demand feed, and inventing one would be worse than using the
 * seventeen data points that are actually ours.
 */
create or replace function fn_sixgen_demand_points()
returns table (lat double precision, lng double precision, t12_revenue numeric, name text)
language sql stable as $$
  select p.lat, p.lng, t.gross_revenue, p.name
    from fn_sixgen_t12() t
    join sixgen_properties p on p.id = t.sixgen_property_id
   where p.lat is not null and p.lng is not null and t.gross_revenue > 0;
$$;

-- ───────────────────────── the ranked result ────────────────────────────────
drop view if exists v_latest_score;
create view v_latest_score with (security_invoker = true) as
  select distinct on (s.property_id) s.*
    from acquisition_scores s
   order by s.property_id, s.computed_at desc, s.id desc;

drop view if exists v_top_candidates;
create view v_top_candidates with (security_invoker = true) as
  select c.*, s.score, s.rank, s.breakdown, s.gated, s.gate_reason,
         s.unavailable_factors, s.computed_at as scored_at,
         s.weights_snapshot
    from v_acquisition_candidates c
    join v_latest_score s on s.property_id = c.property_id
   where not s.gated
   order by s.score desc nulls last;

/** Counts for the dashboard and the Top 25 header. */
create or replace function fn_acquisition_summary(p_market text)
returns table (
  candidates int, scored int, gated int,
  needs_hoa int, requires_review int, green int,
  best_score numeric, median_yield numeric)
language sql stable as $$
  select
    count(*)::int,
    count(s.score)::int,
    count(*) filter (where s.gated)::int,
    count(*) filter (where c.hoa_status = 'HOA_UNKNOWN')::int,
    count(*) filter (where c.classification = 'YELLOW')::int,
    count(*) filter (where c.classification = 'GREEN')::int,
    max(s.score),
    percentile_cont(0.5) within group (order by c.gross_yield_pct)
      filter (where c.gross_yield_pct is not null)::numeric
  from v_acquisition_candidates c
  left join v_latest_score s on s.property_id = c.property_id
  where c.market_id = p_market;
$$;

/** Everything the property page needs, in one call. */
create or replace function fn_property_detail(p_property_id bigint)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'candidate', (select to_jsonb(c) from v_acquisition_candidates c where c.property_id = p_property_id limit 1),
    'score',     (select to_jsonb(s) from v_latest_score s where s.property_id = p_property_id),
    'forecasts', (select coalesce(jsonb_agg(to_jsonb(f) order by f.scenario), '[]'::jsonb)
                    from v_property_forecast f where f.property_id = p_property_id),
    'comps',     (select coalesce(jsonb_agg(jsonb_build_object(
                      'rank', cm.rank, 'similarity', cm.similarity, 'weight', cm.weight,
                      'reasons', cm.reasons, 'adr', cm.adr, 'occupancy', cm.occupancy,
                      'gross_revenue', cm.gross_revenue, 'months_with_data', cm.months_with_data,
                      'name', sp.name, 'beds', sp.beds, 'max_guests', sp.max_guests)
                      order by cm.rank), '[]'::jsonb)
                    from comparable_matches cm
                    join sixgen_properties sp on sp.id = cm.sixgen_property_id
                   where cm.property_id = p_property_id
                     and cm.computed_at = (select max(x.computed_at) from comparable_matches x where x.property_id = p_property_id)),
    'eligibility', (select to_jsonb(e) from v_property_eligibility e where e.property_id = p_property_id),
    'failures',  (select coalesce(jsonb_agg(jsonb_build_object(
                      'code', ef.code, 'severity', ef.severity, 'message', ef.message, 'evidence', ef.evidence)), '[]'::jsonb)
                    from eligibility_failures ef
                   where ef.eligibility_check_id = (select e2.id from v_property_eligibility e2 where e2.property_id = p_property_id)),
    'priceHistory', (select coalesce(jsonb_agg(jsonb_build_object('price', h.price, 'observed_at', h.observed_at)
                      order by h.observed_at), '[]'::jsonb)
                    from listing_price_history h
                    join listings li on li.id = h.listing_id
                   where li.property_id = p_property_id),
    'proForma',  (select to_jsonb(pf) from pro_formas pf where pf.property_id = p_property_id
                   order by pf.is_default desc, pf.updated_at desc limit 1),
    'pipeline',  (select to_jsonb(pl) from acquisition_pipeline pl where pl.property_id = p_property_id),
    'notes',     (select coalesce(jsonb_agg(jsonb_build_object('body', n.body, 'created_at', n.created_at)
                      order by n.created_at desc), '[]'::jsonb)
                    from property_notes n where n.property_id = p_property_id)
  );
$$;
