-- ============================================================================
--  Phase 2 — Existing STR Permit Map
--  · file-import support (geocode cache, per-row provenance, duplicate links)
--  · blocking flag derived from str_rules instead of hardcoded in the sync route
--  · spacing test now inspects every blocking permit inside the radius
--  · exclusion rebuild dedupes on a namespaced key (parcel ids and permit ids
--    are independent sequences and were colliding)
--  Run in Supabase SQL Editor after 0002. Idempotent.
-- ============================================================================

-- ───────────────────────── integrity fixes carried from Phase 1 ─────────────
-- str_rules had no unique key, so re-running seed.sql duplicated every rule and
-- disabling one in Admin left its twin enforcing the same value.
delete from str_rules a using str_rules b
 where a.id > b.id
   and a.jurisdiction_id = b.jurisdiction_id and a.rule_key = b.rule_key
   and a.effective_date = b.effective_date
   and a.applicable_str_type is not distinct from b.applicable_str_type
   and a.applicable_zoning is not distinct from b.applicable_zoning;
-- The zoning list is coalesced to an empty ARRAY rather than joined into a
-- string: array_to_string is only STABLE (it depends on the element type's
-- output function), and Postgres refuses a non-IMMUTABLE function in an index
-- expression. text[] has a btree opclass, so the array compares directly.
create unique index if not exists str_rules_uniq
  on str_rules (jurisdiction_id, rule_key, effective_date,
                coalesce(applicable_str_type, '*'),
                coalesce(applicable_zoning, '{}'::text[]));

-- zoning_districts was inserted (not upserted) on every cache miss.
delete from zoning_districts a using zoning_districts b
 where a.id > b.id and a.jurisdiction_id = b.jurisdiction_id
   and a.source_object_id is not distinct from b.source_object_id;
create unique index if not exists zoning_districts_uniq
  on zoning_districts (jurisdiction_id, source_object_id) where source_object_id is not null;

-- ───────────────────────── permit provenance / match state ──────────────────
alter table str_permits add column if not exists import_row_id      bigint references import_rows(id) on delete set null;
alter table str_permits add column if not exists address_confidence numeric;   -- 0..1 geocoder confidence
alter table str_permits add column if not exists geocode_method     text;      -- address_point | address_point_fuzzy | census | manual | gis_point
alter table str_permits add column if not exists dup_of_permit_id   bigint references str_permits(id) on delete set null;
alter table str_permits add column if not exists review_note        text;
alter table str_permits add column if not exists blocking_reason    text;      -- why is_blocking is what it is
create index if not exists str_permits_match_idx on str_permits(jurisdiction_id, match_status);

create table if not exists geocode_cache (
  id bigserial primary key,
  jurisdiction_id text not null references jurisdictions(id) on delete cascade,
  query_norm text not null,
  matched_address text,
  lat double precision, lng double precision,
  confidence numeric, method text,
  candidates jsonb,
  created_at timestamptz not null default now(),
  unique (jurisdiction_id, query_norm)
);
alter table geocode_cache enable row level security;
drop policy if exists "read geocode_cache" on geocode_cache;
create policy "read geocode_cache" on geocode_cache for select to authenticated using (true);

-- ───────────────────────── blocking rules (data, not code) ──────────────────
-- Which permit statuses count toward the separation rule. 'unknown' is included
-- by default on purpose: an unverified status must never silently un-block a
-- parcel on a legal screen. Editable in Admin → STR Rules.
insert into str_rules (jurisdiction_id, rule_key, rule_name, value_json, applicable_str_type, enabled, source, notes, rules_version)
select 'lfucg', 'blocking_permit_statuses', 'Permit statuses that count toward separation',
       '["active","unknown"]'::jsonb, 'unhosted', true, 'Sixgen policy',
       'Conservative default — an unknown status blocks rather than clears. Narrow it only with evidence from LFUCG.', 'v2026.09'
where not exists (select 1 from str_rules where jurisdiction_id = 'lfucg' and rule_key = 'blocking_permit_statuses');

create or replace function fn_rule_json(p_jurisdiction text, p_key text, p_str_type text default 'unhosted')
returns jsonb language sql stable as $$
  select value_json from str_rules
  where jurisdiction_id = p_jurisdiction and rule_key = p_key and enabled
    and effective_date <= current_date and (end_date is null or end_date >= current_date)
    and (applicable_str_type is null or applicable_str_type = p_str_type)
  order by effective_date desc limit 1;
$$;

-- The str_type the separation rule applies to ('unhosted', or null = every type).
create or replace function fn_spacing_str_type(p_jurisdiction text)
returns text language sql stable as $$
  select applicable_str_type from str_rules
  where jurisdiction_id = p_jurisdiction and rule_key = 'spacing_ft' and enabled
    and effective_date <= current_date and (end_date is null or end_date >= current_date)
  order by effective_date desc limit 1;
$$;

-- Recompute is_blocking for every permit from the current rules. Replaces the
-- hardcoded `p.hosted === "U"` the sync route used to write.
--
-- Fail-safe by design: a permit whose type is unknown is treated as blocking.
-- On a legal screen, "we could not classify this" must never read as "clear".
create or replace function fn_apply_blocking_rules(p_jurisdiction text)
returns table (blocking int, not_blocking int, unknown_type int)
language plpgsql as $$
declare v_type text := fn_spacing_str_type(p_jurisdiction);
        v_statuses text[];
begin
  select coalesce(
           array(select jsonb_array_elements_text(fn_rule_json(p_jurisdiction, 'blocking_permit_statuses'))),
           array['active','unknown']) into v_statuses;

  update str_permits sp set
    is_blocking =
      coalesce(sp.permit_status, 'unknown') = any(v_statuses)
      and (v_type is null or sp.str_type is null or sp.str_type = v_type),
    blocking_reason = case
      when not (coalesce(sp.permit_status, 'unknown') = any(v_statuses))
        then 'status ' || coalesce(sp.permit_status, 'unknown') || ' is not in the blocking set'
      when v_type is not null and sp.str_type is null
        then 'type unknown — blocking by default'
      when v_type is not null and sp.str_type <> v_type
        then 'type ' || sp.str_type || ' is outside the ' || v_type || ' spacing rule'
      else 'matches spacing rule (' || coalesce(v_type, 'all types') || ')' end,
    updated_at = now()
  where sp.jurisdiction_id = p_jurisdiction;

  return query
    select count(*) filter (where sp.is_blocking)::int,
           count(*) filter (where not sp.is_blocking)::int,
           count(*) filter (where sp.str_type is null)::int
      from str_permits sp where sp.jurisdiction_id = p_jurisdiction;
end $$;

-- ───────────────────────── spacing test (rewritten) ─────────────────────────
-- Phase 1 read only the single nearest blocking permit, so a point-measured
-- REVIEW at 300 ft masked a parcel-measured FAIL at 400 ft. Now every blocking
-- permit inside the radius is considered and definite violations win.
create or replace function fn_spacing_test(p_jurisdiction text, p_subject geometry, p_zone text default null)
returns table (result text, spacing_ft numeric, nearest_permit_id bigint, nearest_address text, distance_ft numeric, measured text)
language plpgsql stable as $$
declare v_rule numeric := fn_rule_num(p_jurisdiction, 'spacing_ft', p_zone);
        srid int := fn_srid_feet(p_jurisdiction);
        v_subj geometry;
        r record;
begin
  if v_rule is null then
    return query select 'DATA_REQUIRED'::text, null::numeric, null::bigint, null::text, null::numeric,
                        'spacing_ft rule not configured'::text; return;
  end if;
  v_subj := ST_Transform(p_subject, srid);

  select sp.id as permit_id,
         coalesce(sp.address_norm, sp.address_raw) as addr,
         round(ST_Distance(v_subj, ST_Transform(coalesce(pc.geom, sp.geom), srid))::numeric, 1) as dist,
         case when pc.geom is not null then 'parcel_edge' else 'permit_point' end as how
    into r
    from str_permits sp
    left join parcels pc on pc.id = sp.parcel_id
   where sp.jurisdiction_id = p_jurisdiction and sp.is_blocking
     and coalesce(pc.geom, sp.geom) is not null
     and ST_DWithin(v_subj, ST_Transform(coalesce(pc.geom, sp.geom), srid), v_rule)
     and ST_Distance(v_subj, ST_Transform(coalesce(pc.geom, sp.geom), srid)) < v_rule
   order by (pc.geom is not null) desc,   -- a definite violation outranks an approximate one
            ST_Distance(v_subj, ST_Transform(coalesce(pc.geom, sp.geom), srid)) asc
   limit 1;

  if r.permit_id is null then
    return query select 'PASS'::text, v_rule, null::bigint, null::text, null::numeric,
                        'no blocking permit within spacing'::text; return;
  end if;
  return query select
    case when r.how = 'parcel_edge' then 'FAIL' else 'REVIEW' end,
    v_rule, r.permit_id, r.addr, r.dist, r.how;
end $$;

-- ───────────────────────── parcel linking (rewritten) ───────────────────────
-- Phase 1 skipped rows whose parcel_id was already correct, so a permit reset to
-- match_status='unmatched' by a re-sync stayed 'unmatched' forever; it also
-- overwrote manual corrections on every run.
create or replace function fn_link_permits_to_parcels(p_jurisdiction text)
returns int language plpgsql as $$
declare n int;
begin
  update str_permits sp set
      parcel_id = pc.id,
      match_status = 'matched',
      match_confidence = greatest(coalesce(sp.match_confidence, 0), 0.95),
      match_method = coalesce(nullif(sp.match_method, 'gis_point'), 'gis_point'),
      updated_at = now()
    from parcels pc
   where sp.jurisdiction_id = p_jurisdiction and pc.jurisdiction_id = p_jurisdiction
     and sp.geom is not null and ST_Intersects(pc.geom, sp.geom)
     and sp.match_method is distinct from 'manual'          -- never clobber an operator fix
     and (sp.parcel_id is distinct from pc.id or sp.match_status is distinct from 'matched');
  get diagnostics n = row_count;

  -- located but inside no cached parcel: 'possible', never silently 'matched'
  update str_permits sp set match_status = 'possible', updated_at = now()
   where sp.jurisdiction_id = p_jurisdiction and sp.parcel_id is null
     and sp.geom is not null and sp.match_status = 'unmatched'
     and sp.match_method is distinct from 'manual';
  return n;
end $$;

-- ───────────────────────── exclusion rebuild (rewritten) ────────────────────
-- This gains a `source_count` column over the 0002 definition, and `create or
-- replace` cannot change a function's OUT parameters (42P13). Drop first.
drop function if exists fn_rebuild_exclusions(text);
create or replace function fn_rebuild_exclusions(p_jurisdiction text)
returns table (parcel_count int, permit_count int, source_count int, area_sq_mi double precision)
language plpgsql as $$
declare v_spacing numeric := fn_rule_num(p_jurisdiction, 'spacing_ft');
        srid int := fn_srid_feet(p_jurisdiction);
        v_geom geometry; v_pc int; v_sources int; v_permits int; v_area double precision;
begin
  if v_spacing is null then raise exception 'spacing_ft rule not configured for %', p_jurisdiction; end if;

  -- true count of blocking permits contributing geometry (Phase 1 reported the
  -- deduped source count here, undercounting permits that share a parcel)
  select count(*)::int into v_permits
    from str_permits sp left join parcels pc on pc.id = sp.parcel_id
   where sp.jurisdiction_id = p_jurisdiction and sp.is_blocking
     and coalesce(pc.geom, sp.geom) is not null;

  with src as (
    -- namespaced dedupe key: 'p<parcel id>' vs 's<permit id>'. Phase 1 used
    -- coalesce(pc.id, sp.id), so a permit id could collide with a parcel id and
    -- silently drop a real 600-ft buffer.
    select distinct on (case when pc.id is not null then 'p' || pc.id else 's' || sp.id end)
           coalesce(ST_Transform(pc.geom, srid), ST_Buffer(ST_Transform(sp.geom, srid), 0.5)) as g,
           pc.id as pid
      from str_permits sp
      left join parcels pc on pc.id = sp.parcel_id
     where sp.jurisdiction_id = p_jurisdiction and sp.is_blocking
       and coalesce(pc.geom, sp.geom) is not null
     order by (case when pc.id is not null then 'p' || pc.id else 's' || sp.id end), sp.id
  ),
  buf as (select ST_Buffer(g, v_spacing, 'quad_segs=16') as b, pid from src)
  select ST_Multi(ST_Transform(ST_Union(b), 4326)), count(pid)::int, count(*)::int,
         ST_Area(ST_Union(b)) / 27878400.0
    into v_geom, v_pc, v_sources, v_area
    from buf;

  if v_geom is null then
    delete from market_exclusions where jurisdiction_id = p_jurisdiction;
    return query select 0, coalesce(v_permits, 0), 0, 0::double precision; return;
  end if;

  insert into market_exclusions (jurisdiction_id, rules_version, spacing_ft, geom, parcel_count, permit_count, area_sq_mi, computed_at)
  values (p_jurisdiction, fn_rules_version(p_jurisdiction), v_spacing, v_geom, coalesce(v_pc, 0), coalesce(v_permits, 0), v_area, now())
  on conflict (jurisdiction_id) do update set
    rules_version = excluded.rules_version, spacing_ft = excluded.spacing_ft, geom = excluded.geom,
    parcel_count = excluded.parcel_count, permit_count = excluded.permit_count,
    area_sq_mi = excluded.area_sq_mi, computed_at = now();

  return query select coalesce(v_pc, 0), coalesce(v_permits, 0), coalesce(v_sources, 0), v_area;
end $$;

-- ───────────────────────── match report ─────────────────────────────────────
create or replace function fn_permit_match_report(p_jurisdiction text)
returns table (match_status text, n int, with_parcel int, located int, blocking int)
language sql stable as $$
  select coalesce(match_status, 'unmatched'), count(*)::int,
         count(parcel_id)::int,
         count(*) filter (where geom is not null)::int,
         count(*) filter (where is_blocking)::int
    from str_permits where jurisdiction_id = p_jurisdiction
   group by 1 order by 1;
$$;

-- Candidate parcels near a permit, for the manual-fix picker.
create or replace function fn_parcel_candidates(p_jurisdiction text, p_lng double precision, p_lat double precision, p_radius_ft numeric default 300)
returns table (parcel_id bigint, address text, zone_code text, distance_ft numeric, contains_point boolean)
language plpgsql stable as $$
declare srid int := fn_srid_feet(p_jurisdiction); v_pt geometry; v_wgs geometry;
begin
  v_wgs := ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326);
  v_pt := ST_Transform(v_wgs, srid);
  return query
    select pc.id, pc.address, pc.zone_code,
           round(ST_Distance(v_pt, ST_Transform(pc.geom, srid))::numeric, 1),
           ST_Intersects(pc.geom, v_wgs)
      from parcels pc
     where pc.jurisdiction_id = p_jurisdiction
       and ST_DWithin(v_pt, ST_Transform(pc.geom, srid), p_radius_ft)
     order by 5 desc, 4 asc limit 12;
end $$;
