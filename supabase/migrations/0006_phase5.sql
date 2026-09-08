-- ============================================================================
--  Phase 5 — Sixgen Revenue Intelligence
--
--  The comparable set is Sixgen's own 17 Lexington listings and 24 months of
--  Guesty history. PostGIS is not involved; what SQL owns here is aggregation
--  and the honest handling of the data's known defects. The similarity and
--  weighting live in src/lib/comps/engine.ts, pure and unit-tested, following
--  the same split as Phases 3–4.
--
--  Three properties of the source data drive the design (see data/sixgen/README):
--   · `available_nights` is calendar days, so occupancy is a FLOOR, not true
--     bookable occupancy. Owner and maintenance blocks are unknown.
--   · A listing that went live mid-window has leading zero months that are not
--     vacancy. Trailing-12 is therefore the comparison basis, never 24-month.
--   · Revenue is attributed to the check-in month, so a long stay lands wholly
--     in one month. Single months are noisy; annual totals are not.
--
--  Run in Supabase SQL Editor after 0005. Idempotent.
-- ============================================================================

-- ───────────────────────── portfolio shape ──────────────────────────────────
alter table sixgen_properties add column if not exists guesty_id     text;
alter table sixgen_properties add column if not exists zip           text;
alter table sixgen_properties add column if not exists lat           double precision;
alter table sixgen_properties add column if not exists lng           double precision;
alter table sixgen_properties add column if not exists property_type text;
alter table sixgen_properties add column if not exists golf_sim      boolean;
alter table sixgen_properties add column if not exists fire_pit      boolean;
alter table sixgen_properties add column if not exists pool_table    boolean;
alter table sixgen_properties add column if not exists notes         text;
alter table sixgen_properties add column if not exists updated_at    timestamptz not null default now();

create unique index if not exists sixgen_properties_guesty_uniq
  on sixgen_properties (guesty_id) where guesty_id is not null;

-- ───────────────────────── append-only history, made real ───────────────────
-- The table was declared append-only with `unique (sixgen_property_id, year,
-- month, import_id)`, but import_id was nullable — and NULLs are distinct in a
-- unique constraint, so re-importing the same file silently doubled every month
-- and would have doubled every comp. Give the column a real value, then the
-- constraint does what it says.
alter table sixgen_monthly_performance add column if not exists reservations int;
alter table sixgen_monthly_performance add column if not exists source       text default 'guesty';

update sixgen_monthly_performance set import_id = 0 where import_id is null;
alter table sixgen_monthly_performance alter column import_id set default 0;
alter table sixgen_monthly_performance alter column import_id set not null;

update sixgen_annual_performance set import_id = 0 where import_id is null;
alter table sixgen_annual_performance alter column import_id set default 0;
alter table sixgen_annual_performance alter column import_id set not null;

create index if not exists sixgen_monthly_lookup
  on sixgen_monthly_performance (sixgen_property_id, year desc, month desc);

/**
 * The current reading for each property-month: history is kept, but a comp is
 * built from the newest import only.
 */
drop view if exists v_sixgen_monthly_current;
create view v_sixgen_monthly_current with (security_invoker = true) as
  select distinct on (m.sixgen_property_id, m.year, m.month) m.*
    from sixgen_monthly_performance m
   order by m.sixgen_property_id, m.year, m.month, m.import_id desc, m.id desc;

-- ───────────────────────── trailing twelve months ───────────────────────────
/**
 * T12 per property, measured from the most recent month present in the data set
 * so every comp covers the same window.
 *
 * `months_with_data` counts months that actually had a booking. A listing that
 * went live inside the window reports fewer, and the engine downweights it
 * rather than reading its pre-launch zeros as vacancy.
 */
create or replace function fn_sixgen_t12()
returns table (
  sixgen_property_id bigint, name text, beds int, baths numeric, max_guests int,
  hot_tub boolean, golf_sim boolean, game_room boolean, pool boolean, fire_pit boolean, pool_table boolean,
  window_start date, window_end date, months int, months_with_data int,
  gross_revenue numeric, occupied_nights int, available_nights int,
  occupancy numeric, adr numeric, revpar numeric,
  first_booked_month date, is_partial_year boolean)
language plpgsql stable as $$
declare v_end date;
begin
  -- the newest month anywhere in the data set, so every comp covers one window
  select make_date(m.year, m.month, 1) into v_end
    from v_sixgen_monthly_current m
   order by m.year desc, m.month desc
   limit 1;
  if v_end is null then return; end if;

  return query
  with win as (select v_end as w_end, (v_end - interval '11 months')::date as w_start),
  rows_in as (
    select m.*, make_date(m.year, m.month, 1) as mdate
      from v_sixgen_monthly_current m, win
     where make_date(m.year, m.month, 1) between win.w_start and win.w_end
  ),
  agg as (
    select r.sixgen_property_id,
           count(*)::int                                              as months,
           count(*) filter (where coalesce(r.occupied_nights,0) > 0)::int as months_with_data,
           sum(coalesce(r.gross_revenue,0))::numeric                  as gross_revenue,
           sum(coalesce(r.occupied_nights,0))::int                    as occupied_nights,
           sum(coalesce(r.available_nights,0))::int                   as available_nights,
           min(r.mdate) filter (where coalesce(r.occupied_nights,0) > 0) as first_booked_month
      from rows_in r group by r.sixgen_property_id
  )
  select p.id, p.name, p.beds, p.baths, p.max_guests,
         p.hot_tub, p.golf_sim, p.game_room, p.pool, p.fire_pit, p.pool_table,
         (select w_start from win), (select w_end from win),
         a.months, a.months_with_data,
         round(a.gross_revenue, 2),
         a.occupied_nights, a.available_nights,
         case when a.available_nights > 0
              then round(a.occupied_nights::numeric / a.available_nights, 4) end,
         case when a.occupied_nights > 0
              then round(a.gross_revenue / a.occupied_nights, 2) end,
         case when a.available_nights > 0
              then round(a.gross_revenue / a.available_nights, 2) end,
         a.first_booked_month,
         (a.months_with_data < a.months)
    from agg a join sixgen_properties p on p.id = a.sixgen_property_id
   where p.active
   order by p.beds desc nulls last, a.gross_revenue desc;
end $$;

/** Month-of-year shape across the portfolio, for distributing an annual forecast. */
create or replace function fn_sixgen_seasonality(p_beds_min int default null, p_beds_max int default null)
returns table (month int, adr_index numeric, occupancy numeric, months_counted int)
language sql stable as $$
  with base as (
    select m.month, m.adr, m.occupancy
      from v_sixgen_monthly_current m
      join sixgen_properties p on p.id = m.sixgen_property_id
     where p.active and coalesce(m.occupied_nights, 0) > 0
       and (p_beds_min is null or p.beds >= p_beds_min)
       and (p_beds_max is null or p.beds <= p_beds_max)
  ),
  overall as (select avg(adr) as mean_adr from base)
  select b.month,
         round((avg(b.adr) / nullif((select mean_adr from overall), 0))::numeric, 4),
         round(avg(b.occupancy)::numeric, 4),
         count(*)::int
    from base b group by b.month order by b.month;
$$;

-- ───────────────────────── forecast provenance ──────────────────────────────
alter table revenue_forecasts add column if not exists comp_count      int;
alter table revenue_forecasts add column if not exists comp_coverage   numeric;   -- 0..1
alter table revenue_forecasts add column if not exists occupancy_cap   numeric;
alter table revenue_forecasts add column if not exists basis           text;      -- 'sixgen_t12'
alter table revenue_forecasts add column if not exists gross_yield_pct numeric;
alter table revenue_forecasts add column if not exists listing_price   bigint;
create index if not exists forecast_latest_idx on revenue_forecasts(property_id, scenario, computed_at desc);

alter table comparable_matches add column if not exists rank            int;
alter table comparable_matches add column if not exists adr             numeric;
alter table comparable_matches add column if not exists occupancy       numeric;
alter table comparable_matches add column if not exists gross_revenue   numeric;
alter table comparable_matches add column if not exists months_with_data int;

drop view if exists v_property_forecast;
create view v_property_forecast with (security_invoker = true) as
  select distinct on (f.property_id, f.scenario) f.*
    from revenue_forecasts f
   order by f.property_id, f.scenario, f.computed_at desc, f.id desc;

/** Portfolio-level reference figures shown beside every forecast. */
create or replace function fn_sixgen_portfolio_summary()
returns table (listings int, t12_revenue numeric, occupancy numeric, adr numeric,
               window_start date, window_end date, partial_year_listings int)
language sql stable as $$
  select count(*)::int,
         round(sum(t.gross_revenue), 2),
         case when sum(t.available_nights) > 0
              then round(sum(t.occupied_nights)::numeric / sum(t.available_nights), 4) end,
         case when sum(t.occupied_nights) > 0
              then round(sum(t.gross_revenue) / sum(t.occupied_nights), 2) end,
         min(t.window_start), max(t.window_end),
         count(*) filter (where t.is_partial_year)::int
    from fn_sixgen_t12() t;
$$;
