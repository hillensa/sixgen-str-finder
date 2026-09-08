-- ============================================================================
--  Phase 3 — Eligibility Engine
--
--  Division of labour, following the pattern set in Phases 1–2: PostGIS owns
--  the geometry and the rule lookups and returns *facts*; src/lib/eligibility.ts
--  turns those facts into GREEN / RED / YELLOW and one explained row per reason.
--  One classifier, unit-tested, shared by the ad-hoc Test Address check and the
--  batch re-run.
--
--  Run in Supabase SQL Editor after 0003. Idempotent.
-- ============================================================================

-- ───────────────────────── eligibility_checks provenance ────────────────────
alter table eligibility_checks add column if not exists parcel_id          bigint references parcels(id) on delete set null;
alter table eligibility_checks add column if not exists spacing_ft         numeric;   -- the rule value in force
alter table eligibility_checks add column if not exists spacing_measured   text;      -- parcel_edge | permit_point
alter table eligibility_checks add column if not exists density_radius_ft  numeric;
alter table eligibility_checks add column if not exists zone_ordinance_url text;
alter table eligibility_checks add column if not exists subject_source     text;      -- parcel | point
alter table eligibility_checks add column if not exists summary            text;

-- ───────────────────────── the fact set ─────────────────────────────────────
-- A named composite type so the column list is declared once and every entry
-- point returns exactly the same shape.
drop function if exists fn_eligibility_facts_for_parcel(text, bigint);
drop function if exists fn_eligibility_facts_at_point(text, double precision, double precision);
drop function if exists fn_eligibility_facts(text, geometry, text, text);
drop type if exists eligibility_facts;

create type eligibility_facts as (
  zone_code             text,
  zone_ordinance_url    text,
  zoning_treatment      text,
  zoning_source         text,
  zoning_notes          text,
  spacing_result        text,
  spacing_ft            numeric,
  nearest_permit_id     bigint,
  nearest_address       text,
  nearest_distance_ft   numeric,
  spacing_measured      text,
  density_result        text,
  density_radius_ft     numeric,
  density_threshold_pct numeric,
  density_strs          int,
  density_units         int,
  density_pct           numeric,
  density_pct_after     numeric,
  rules_version         text
);

-- ───────────────────────── zoning treatment lookup ──────────────────────────
-- The SQL counterpart of zoningTreatmentFor() in lib/rules.ts, with the
-- effective-date window that the client-side helper cannot apply.
create or replace function fn_zoning_treatment(p_jurisdiction text, p_zone text, p_str_type text default 'unhosted')
returns table (treatment text, rule_id bigint, source text, notes text)
language sql stable as $$
  select r.value_text, r.id, r.source, r.notes
    from str_rules r
   where r.jurisdiction_id = p_jurisdiction and r.rule_key = 'zoning_treatment' and r.enabled
     and r.effective_date <= current_date and (r.end_date is null or r.end_date >= current_date)
     and (r.applicable_str_type is null or r.applicable_str_type = p_str_type)
     and p_zone is not null
     and (r.applicable_zoning is null
          or upper(btrim(p_zone)) = any (select upper(btrim(x)) from unnest(r.applicable_zoning) x))
   order by (r.applicable_zoning is not null) desc, r.effective_date desc
   limit 1;
$$;

-- ───────────────────────── density test (revised) ───────────────────────────
-- Phase 1 collapsed two different situations into DATA_REQUIRED:
--   · no density rule is configured at all — Lexington today, because the
--     1,000-ft rule ships disabled pending confirmation of the ordinance; and
--   · a rule IS in force but there is no dwelling-unit denominator.
-- Only the second is a caveat on a screening result. Conflating them left every
-- property permanently un-GREEN over a rule nobody has established exists, so
-- the first now returns NOT_CONFIGURED and the classifier ignores it. The
-- original promise is unchanged: a percentage is never invented.
create or replace function fn_density_test(p_jurisdiction text, p_subject geometry, p_zone text default null)
returns table (result text, radius_ft numeric, threshold_pct numeric, existing_strs int, dwelling_units int, pct_now numeric, pct_after numeric)
language plpgsql stable as $$
declare v_radius numeric := fn_rule_num(p_jurisdiction, 'density_radius_ft', p_zone);
        v_thresh numeric := fn_rule_num(p_jurisdiction, 'density_max_pct', p_zone);
        srid int := fn_srid_feet(p_jurisdiction);
        v_strs int; v_units int; v_subj geometry;
begin
  if v_radius is null or v_thresh is null then
    return query select 'NOT_CONFIGURED'::text, v_radius, v_thresh, null::int, null::int, null::numeric, null::numeric; return;
  end if;

  v_subj := ST_Transform(p_subject, srid);
  select count(*)::int into v_strs from str_permits sp
   where sp.jurisdiction_id = p_jurisdiction and sp.is_blocking and sp.geom is not null
     and ST_DWithin(ST_Transform(sp.geom, srid), v_subj, v_radius);

  -- non-numeric junk in the attribute must not abort the whole screen
  select coalesce(sum(coalesce(nullif(regexp_replace(coalesce(pc.attrs->>'dwelling_units',''), '[^0-9]', '', 'g'), '')::int, 0)), 0)::int
    into v_units
    from parcels pc
   where pc.jurisdiction_id = p_jurisdiction
     and ST_DWithin(ST_Transform(pc.geom, srid), v_subj, v_radius);

  if v_units is null or v_units = 0 then
    return query select 'DATA_REQUIRED'::text, v_radius, v_thresh, v_strs, 0, null::numeric, null::numeric; return;
  end if;

  return query select
    case when (v_strs + 1)::numeric / v_units * 100 <= v_thresh then 'PASS' else 'FAIL' end,
    v_radius, v_thresh, v_strs, v_units,
    round(v_strs::numeric / v_units * 100, 2),
    round((v_strs + 1)::numeric / v_units * 100, 2);
end $$;

-- ───────────────────────── one round trip for all the facts ─────────────────
create or replace function fn_eligibility_facts(
  p_jurisdiction text, p_subject geometry, p_zone text default null, p_str_type text default 'unhosted')
returns setof eligibility_facts
language plpgsql stable as $$
declare v_zone text := p_zone; v_url text; s record; d record; t record; out eligibility_facts;
begin
  if v_zone is null then
    select z.zone_code, z.ordinance_url into v_zone, v_url
      from zoning_districts z
     where z.jurisdiction_id = p_jurisdiction
       and ST_Intersects(z.geom, ST_PointOnSurface(p_subject))
     limit 1;
  else
    select z.ordinance_url into v_url from zoning_districts z
     where z.jurisdiction_id = p_jurisdiction and upper(btrim(z.zone_code)) = upper(btrim(v_zone))
     order by z.fetched_at desc limit 1;
  end if;

  select * into s from fn_spacing_test(p_jurisdiction, p_subject, v_zone);
  select * into d from fn_density_test(p_jurisdiction, p_subject, v_zone);
  select * into t from fn_zoning_treatment(p_jurisdiction, v_zone, p_str_type);

  out.zone_code := v_zone;               out.zone_ordinance_url := v_url;
  out.zoning_treatment := t.treatment;   out.zoning_source := t.source;   out.zoning_notes := t.notes;
  out.spacing_result := s.result;        out.spacing_ft := s.spacing_ft;
  out.nearest_permit_id := s.nearest_permit_id;   out.nearest_address := s.nearest_address;
  out.nearest_distance_ft := s.distance_ft;       out.spacing_measured := s.measured;
  out.density_result := d.result;        out.density_radius_ft := d.radius_ft;
  out.density_threshold_pct := d.threshold_pct;   out.density_strs := d.existing_strs;
  out.density_units := d.dwelling_units; out.density_pct := d.pct_now;   out.density_pct_after := d.pct_after;
  out.rules_version := fn_rules_version(p_jurisdiction);
  return next out;
end $$;

-- ───────────────────────── RPC-callable wrappers ────────────────────────────
-- PostgREST cannot pass a `geometry` argument, so the entry points the app calls
-- take a parcel id or a coordinate pair.

/** Facts measured from a cached parcel polygon — property line to property line. */
create or replace function fn_eligibility_facts_for_parcel(p_jurisdiction text, p_parcel_id bigint)
returns setof eligibility_facts language plpgsql stable as $$
declare v_geom geometry; v_zone text;
begin
  select pc.geom, pc.zone_code into v_geom, v_zone
    from parcels pc where pc.id = p_parcel_id and pc.jurisdiction_id = p_jurisdiction;
  if v_geom is null then raise exception 'parcel % not found in %', p_parcel_id, p_jurisdiction; end if;
  return query select * from fn_eligibility_facts(p_jurisdiction, v_geom, v_zone);
end $$;

/** Facts measured from a bare WGS84 point — used only when no parcel matched. */
create or replace function fn_eligibility_facts_at_point(p_jurisdiction text, p_lng double precision, p_lat double precision)
returns setof eligibility_facts language plpgsql stable as $$
begin
  return query select * from fn_eligibility_facts(
    p_jurisdiction, ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326), null);
end $$;

-- ───────────────────────── properties → parcels ─────────────────────────────
-- Separation is measured parcel line to parcel line, so a property needs its
-- parcel before it can be screened. A property inside no cached parcel keeps
-- parcel_id null and is screened from its point, which the classifier downgrades
-- to REVIEW rather than treating as exact.
create or replace function fn_link_properties_to_parcels(p_market text)
returns int language plpgsql as $$
declare n int;
begin
  update properties pr set parcel_id = pc.id, parcel_match_confidence = 0.95, updated_at = now()
    from parcels pc, jurisdictions j
   where pr.market_id = p_market and j.market_id = p_market and pc.jurisdiction_id = j.id
     and pr.geom is not null and ST_Intersects(pc.geom, pr.geom)
     and pr.parcel_id is distinct from pc.id;
  get diagnostics n = row_count;
  return n;
end $$;

-- Facts for many properties in one call, so a re-run costs one round trip per
-- batch rather than one per property.
create or replace function fn_eligibility_facts_for_properties(p_property_ids bigint[])
returns table (
  property_id bigint, jurisdiction_id text, parcel_id bigint, subject_source text,
  hoa_status text, parcel_match_confidence numeric,
  zone_code text, zone_ordinance_url text,
  zoning_treatment text, zoning_source text, zoning_notes text,
  spacing_result text, spacing_ft numeric, nearest_permit_id bigint, nearest_address text,
  nearest_distance_ft numeric, spacing_measured text,
  density_result text, density_radius_ft numeric, density_threshold_pct numeric,
  density_strs int, density_units int, density_pct numeric, density_pct_after numeric,
  rules_version text)
language plpgsql stable as $$
declare r record; f eligibility_facts; v_jid text; v_subject geometry;
begin
  for r in
    select pr.id, pr.market_id, pr.parcel_id, pr.hoa_status, pr.parcel_match_confidence,
           pr.geom as point_geom, pc.geom as parcel_geom, pc.zone_code as parcel_zone
      from properties pr
      left join parcels pc on pc.id = pr.parcel_id
     where pr.id = any(p_property_ids)
  loop
    select j.id into v_jid from jurisdictions j where j.market_id = r.market_id limit 1;
    continue when v_jid is null;

    v_subject := coalesce(r.parcel_geom, r.point_geom);
    continue when v_subject is null;

    select * into f from fn_eligibility_facts(v_jid, v_subject, r.parcel_zone);

    property_id := r.id; jurisdiction_id := v_jid; parcel_id := r.parcel_id;
    subject_source := case when r.parcel_geom is not null then 'parcel' else 'point' end;
    hoa_status := r.hoa_status; parcel_match_confidence := r.parcel_match_confidence;
    zone_code := f.zone_code; zone_ordinance_url := f.zone_ordinance_url;
    zoning_treatment := f.zoning_treatment; zoning_source := f.zoning_source; zoning_notes := f.zoning_notes;
    spacing_result := f.spacing_result; spacing_ft := f.spacing_ft;
    nearest_permit_id := f.nearest_permit_id; nearest_address := f.nearest_address;
    nearest_distance_ft := f.nearest_distance_ft; spacing_measured := f.spacing_measured;
    density_result := f.density_result; density_radius_ft := f.density_radius_ft;
    density_threshold_pct := f.density_threshold_pct; density_strs := f.density_strs;
    density_units := f.density_units; density_pct := f.density_pct; density_pct_after := f.density_pct_after;
    rules_version := f.rules_version;
    return next;
  end loop;
end $$;

-- ───────────────────────── latest result per property ───────────────────────
drop view if exists v_property_eligibility;
create view v_property_eligibility with (security_invoker = true) as
  select distinct on (ec.property_id) ec.*
    from eligibility_checks ec
   order by ec.property_id, ec.checked_at desc, ec.id desc;

create index if not exists elig_classification_idx on eligibility_checks(classification, checked_at desc);
create index if not exists elig_failures_check_idx on eligibility_failures(eligibility_check_id);

-- Counts for the dashboard and the re-run summary.
create or replace function fn_eligibility_summary(p_market text)
returns table (classification text, n int)
language sql stable as $$
  select v.classification, count(*)::int
    from v_property_eligibility v
    join properties pr on pr.id = v.property_id
   where pr.market_id = p_market
   group by 1 order by 1;
$$;
