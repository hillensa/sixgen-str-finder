-- ============================================================================
--  Spatial functions — authoritative GIS math in PostGIS.
--  All distances computed in the market's projected foot-based SRID.
-- ============================================================================

-- Active numeric rule for a jurisdiction (latest effective, enabled).
create or replace function fn_rule_num(p_jurisdiction text, p_key text, p_zone text default null, p_str_type text default 'unhosted')
returns numeric language sql stable as $$
  select value_num from str_rules
  where jurisdiction_id = p_jurisdiction and rule_key = p_key and enabled
    and effective_date <= current_date and (end_date is null or end_date >= current_date)
    and (applicable_str_type is null or applicable_str_type = p_str_type)
    and (applicable_zoning is null or p_zone = any(applicable_zoning))
  order by (applicable_zoning is not null) desc, effective_date desc
  limit 1;
$$;

create or replace function fn_rules_version(p_jurisdiction text)
returns text language sql stable as $$
  select coalesce(max(rules_version), 'unversioned') from str_rules where jurisdiction_id = p_jurisdiction and enabled;
$$;

create or replace function fn_srid_feet(p_jurisdiction text)
returns int language sql stable as $$
  select m.srid_feet from jurisdictions j join markets m on m.id = j.market_id where j.id = p_jurisdiction;
$$;

-- Parcel containing a WGS84 point (from cache).
create or replace function fn_parcel_at(p_jurisdiction text, p_lng double precision, p_lat double precision)
returns table (parcel_id bigint, address text, zone_code text, acreage numeric, pva_id text)
language sql stable as $$
  select id, address, zone_code, acreage, pva_id from parcels
  where jurisdiction_id = p_jurisdiction
    and ST_Intersects(geom, ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326))
  limit 1;
$$;

-- Zoning district containing a WGS84 point (from cache).
create or replace function fn_zoning_at(p_jurisdiction text, p_lng double precision, p_lat double precision)
returns table (zone_code text, zone_name text, ordinance_url text)
language sql stable as $$
  select zone_code, zone_name, ordinance_url from zoning_districts
  where jurisdiction_id = p_jurisdiction
    and ST_Intersects(geom, ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326))
  limit 1;
$$;

-- Nearest BLOCKING STR to a subject geometry, measured parcel-edge to parcel-edge
-- when both parcels are known; falls back to point geometry otherwise.
create or replace function fn_nearest_blocking_str(p_jurisdiction text, p_subject geometry)
returns table (permit_id bigint, address text, distance_ft numeric, measured text)
language plpgsql stable as $$
declare srid int := fn_srid_feet(p_jurisdiction);
begin
  return query
  select sp.id, coalesce(sp.address_norm, sp.address_raw),
         round(ST_Distance(ST_Transform(p_subject, srid),
                           ST_Transform(coalesce(pc.geom, sp.geom), srid))::numeric, 1),
         case when pc.geom is not null then 'parcel_edge' else 'permit_point' end
  from str_permits sp
  left join parcels pc on pc.id = sp.parcel_id
  where sp.jurisdiction_id = p_jurisdiction and sp.is_blocking
    and coalesce(pc.geom, sp.geom) is not null
  order by ST_Transform(p_subject, srid) <-> ST_Transform(coalesce(pc.geom, sp.geom), srid)
  limit 1;
end $$;

-- Spacing test result for a subject geometry.
create or replace function fn_spacing_test(p_jurisdiction text, p_subject geometry, p_zone text default null)
returns table (result text, spacing_ft numeric, nearest_permit_id bigint, nearest_address text, distance_ft numeric, measured text)
language plpgsql stable as $$
declare v_rule numeric := fn_rule_num(p_jurisdiction, 'spacing_ft', p_zone);
        r record;
begin
  if v_rule is null then
    return query select 'DATA_REQUIRED'::text, null::numeric, null::bigint, null::text, null::numeric, null::text; return;
  end if;
  select * into r from fn_nearest_blocking_str(p_jurisdiction, p_subject);
  if r.permit_id is null then
    return query select 'PASS'::text, v_rule, null::bigint, null::text, null::numeric, 'no_blocking_permits'::text; return;
  end if;
  return query select
    case when r.distance_ft >= v_rule then 'PASS' when r.measured = 'permit_point' then 'REVIEW' else 'FAIL' end,
    v_rule, r.permit_id, r.address, r.distance_ft, r.measured;
end $$;

-- Density test. Denominator = residential address points cached in `parcels.attrs->>'dwelling_units'`
-- or a dwelling_units table if/when loaded. Returns DATA_REQUIRED unless a denominator exists.
create or replace function fn_density_test(p_jurisdiction text, p_subject geometry, p_zone text default null)
returns table (result text, radius_ft numeric, threshold_pct numeric, existing_strs int, dwelling_units int, pct_now numeric, pct_after numeric)
language plpgsql stable as $$
declare v_radius numeric := fn_rule_num(p_jurisdiction, 'density_radius_ft', p_zone);
        v_thresh numeric := fn_rule_num(p_jurisdiction, 'density_max_pct', p_zone);
        srid int := fn_srid_feet(p_jurisdiction);
        v_strs int; v_units int;
begin
  if v_radius is null or v_thresh is null then
    return query select 'DATA_REQUIRED'::text, v_radius, v_thresh, null::int, null::int, null::numeric, null::numeric; return;
  end if;
  select count(*) into v_strs from str_permits sp
   where sp.jurisdiction_id = p_jurisdiction and sp.is_blocking and sp.geom is not null
     and ST_DWithin(ST_Transform(sp.geom, srid), ST_Transform(p_subject, srid), v_radius);
  select coalesce(sum(coalesce((attrs->>'dwelling_units')::int, 0)), 0) into v_units from parcels pc
   where pc.jurisdiction_id = p_jurisdiction
     and ST_DWithin(ST_Transform(pc.geom, srid), ST_Transform(p_subject, srid), v_radius);
  if v_units is null or v_units = 0 then
    return query select 'DATA_REQUIRED'::text, v_radius, v_thresh, v_strs, 0, null::numeric, null::numeric; return;
  end if;
  return query select
    case when (v_strs + 1)::numeric / v_units * 100 <= v_thresh then 'PASS' else 'FAIL' end,
    v_radius, v_thresh, v_strs, v_units,
    round(v_strs::numeric / v_units * 100, 2),
    round((v_strs + 1)::numeric / v_units * 100, 2);
end $$;

-- Rebuild the dissolved exclusion zone from blocking permits' parcels.
create or replace function fn_rebuild_exclusions(p_jurisdiction text)
returns table (parcel_count int, permit_count int, area_sq_mi double precision)
language plpgsql as $$
declare v_spacing numeric := fn_rule_num(p_jurisdiction, 'spacing_ft');
        srid int := fn_srid_feet(p_jurisdiction);
        v_geom geometry; v_pc int; v_permits int; v_area double precision;
begin
  if v_spacing is null then raise exception 'spacing_ft rule not configured for %', p_jurisdiction; end if;

  with src as (
    select distinct on (coalesce(pc.id, sp.id)) coalesce(pc.geom, ST_Buffer(ST_Transform(sp.geom, srid), 0.1)) as g, pc.id as pid
    from str_permits sp left join parcels pc on pc.id = sp.parcel_id
    where sp.jurisdiction_id = p_jurisdiction and sp.is_blocking and coalesce(pc.geom, sp.geom) is not null
  ),
  buf as (select ST_Buffer(ST_Transform(g, srid), v_spacing, 'quad_segs=16') as b, pid from src)
  select ST_Multi(ST_Transform(ST_Union(b), 4326)), count(*), count(pid),
         ST_Area(ST_Union(b)) / 27878400.0
    into v_geom, v_permits, v_pc, v_area from buf;

  insert into market_exclusions (jurisdiction_id, rules_version, spacing_ft, geom, parcel_count, permit_count, area_sq_mi, computed_at)
  values (p_jurisdiction, fn_rules_version(p_jurisdiction), v_spacing, v_geom, coalesce(v_pc,0), coalesce(v_permits,0), v_area, now())
  on conflict (jurisdiction_id) do update set
    rules_version = excluded.rules_version, spacing_ft = excluded.spacing_ft, geom = excluded.geom,
    parcel_count = excluded.parcel_count, permit_count = excluded.permit_count,
    area_sq_mi = excluded.area_sq_mi, computed_at = now();

  return query select coalesce(v_pc,0), coalesce(v_permits,0), v_area;
end $$;

-- Convenience: keep point geometry in sync from lat/lng on insert/update.
create or replace function trg_sync_point_geom() returns trigger language plpgsql as $$
begin
  if new.lat is not null and new.lng is not null then
    new.geom := ST_SetSRID(ST_MakePoint(new.lng, new.lat), 4326);
  end if;
  return new;
end $$;
drop trigger if exists str_permits_geom on str_permits;
create trigger str_permits_geom before insert or update of lat, lng on str_permits
  for each row execute function trg_sync_point_geom();
drop trigger if exists properties_geom on properties;
create trigger properties_geom before insert or update of lat, lng on properties
  for each row execute function trg_sync_point_geom();

-- Expose exclusion zone as GeoJSON for the map (RLS-readable).
create or replace view v_market_exclusions_geojson as
  select jurisdiction_id, rules_version, spacing_ft, parcel_count, permit_count, area_sq_mi, computed_at,
         ST_AsGeoJSON(geom)::jsonb as geojson
  from market_exclusions;

-- Link permits to the parcel containing their point; sets match status/confidence.
create or replace function fn_link_permits_to_parcels(p_jurisdiction text)
returns int language plpgsql as $$
declare n int;
begin
  update str_permits sp set parcel_id = pc.id, match_status = 'matched', match_confidence = 0.95,
         match_method = coalesce(sp.match_method, 'gis_point'), updated_at = now()
    from parcels pc
   where sp.jurisdiction_id = p_jurisdiction and pc.jurisdiction_id = p_jurisdiction
     and sp.geom is not null and ST_Intersects(pc.geom, sp.geom)
     and (sp.parcel_id is distinct from pc.id);
  get diagnostics n = row_count;
  return n;
end $$;
