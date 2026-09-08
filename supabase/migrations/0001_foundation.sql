-- ============================================================================
--  Sixgen STR Finder — Foundation schema (v2, PostGIS)
--  Run in Supabase SQL Editor. Idempotent.
-- ============================================================================
create extension if not exists postgis;
create extension if not exists "uuid-ossp";

-- ───────────────────────────── reference ────────────────────────────────────
create table if not exists markets (
  id text primary key,                          -- 'lexington-ky'
  name text not null,
  state text not null,
  center_lat double precision not null,
  center_lng double precision not null,
  default_zoom int not null default 12,
  srid_feet int not null,                       -- projected SRID in feet (KY North = 2246)
  proj4 text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists jurisdictions (
  id text primary key,                          -- 'lfucg'
  market_id text not null references markets(id) on delete cascade,
  name text not null,                           -- 'Lexington-Fayette Urban County Government'
  planning_contact text,
  gis_str_url text, gis_parcel_url text, gis_zoning_url text,
  gis_boundary_url text, gis_address_url text, gis_building_url text,
  created_at timestamptz not null default now()
);

-- Regulatory rules: versioned, never hardcoded in app logic.
create table if not exists str_rules (
  id bigserial primary key,
  jurisdiction_id text not null references jurisdictions(id) on delete cascade,
  rule_key text not null,      -- 'spacing_ft' | 'density_radius_ft' | 'density_max_pct' | 'occupancy_ceiling' | 'zoning_treatment' | 'max_guests_per_bedroom' ...
  rule_name text not null,
  value_num numeric,
  value_text text,
  value_json jsonb,
  applicable_zoning text[],    -- null = all zones
  applicable_str_type text,    -- 'unhosted' | 'hosted' | null = both
  effective_date date not null default current_date,
  end_date date,
  enabled boolean not null default true,
  source text,                 -- ordinance citation / URL
  notes text,
  rules_version text not null default 'v2026.09',
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists str_rules_lookup on str_rules(jurisdiction_id, rule_key, enabled);

create table if not exists scoring_weights (
  id bigserial primary key,
  market_id text not null references markets(id) on delete cascade,
  factor_key text not null,    -- 'revenue_yield' | 'absolute_revenue' | 'comp_strength' | ...
  factor_name text not null,
  weight numeric not null,     -- 0..1, weights should sum to 1 per market
  enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  unique (market_id, factor_key)
);

create table if not exists app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- ───────────────────────────── identity ─────────────────────────────────────
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);
create table if not exists allowed_emails (
  email text primary key,
  invited_by uuid references auth.users(id),
  note text,
  created_at timestamptz not null default now()
);
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from allowed_emails a where lower(a.email)=lower(new.email)) then
    raise exception 'This email is not invited. Contact your administrator.';
  end if;
  insert into profiles (id,email,is_admin)
  values (new.id,new.email,coalesce((select count(*)=0 from profiles),false))
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_user();

-- ───────────────────────────── government GIS cache ─────────────────────────
create table if not exists zoning_districts (
  id bigserial primary key,
  jurisdiction_id text not null references jurisdictions(id) on delete cascade,
  zone_code text not null,                  -- 'R-1C'
  zone_name text,
  ordinance_url text,
  source_object_id bigint,
  geom geometry(MultiPolygon,4326),
  source text default 'LFUCG GIS',
  fetched_at timestamptz not null default now()
);
create index if not exists zoning_geom_gix on zoning_districts using gist(geom);
create index if not exists zoning_code_idx on zoning_districts(jurisdiction_id, zone_code);

create table if not exists parcels (
  id bigserial primary key,
  jurisdiction_id text not null references jurisdictions(id) on delete cascade,
  source_object_id bigint,                  -- LFUCG OBJECTID
  pva_id text,                              -- parcel number when available
  address text,
  zone_code text,
  acreage numeric,
  centroid_lat double precision,
  centroid_lng double precision,
  geom geometry(MultiPolygon,4326) not null,
  attrs jsonb,                              -- any extra attributes from source
  source text default 'LFUCG GIS',
  fetched_at timestamptz not null default now(),
  unique (jurisdiction_id, source_object_id)
);
create index if not exists parcels_geom_gix on parcels using gist(geom);
create index if not exists parcels_addr_idx on parcels(jurisdiction_id, address);

-- ───────────────────────────── STR supply ───────────────────────────────────
create table if not exists str_permits (
  id bigserial primary key,
  jurisdiction_id text not null references jurisdictions(id) on delete cascade,
  import_id bigint,
  external_id text,                         -- city objectid or file row key
  permit_number text,
  owner text,
  address_raw text,
  address_norm text,
  unit text,
  zip text,
  str_type text,                            -- 'unhosted' | 'hosted' | null
  permit_status text,                       -- 'active' | 'expired' | 'pending' | 'unknown'
  cup_status text,                          -- conditional use permit status
  legal_nonconforming boolean,
  issue_date date, expiration_date date,
  lat double precision, lng double precision,
  geom geometry(Point,4326),
  parcel_id bigint references parcels(id),
  match_status text default 'unmatched',    -- 'matched'|'possible'|'unmatched'|'duplicate'|'invalid'
  match_confidence numeric,                 -- 0..1
  match_method text,                        -- 'gis_point'|'address_point'|'geocode'|'manual'
  is_blocking boolean,                      -- derived: counts toward spacing rule
  source text default 'city_gis',
  source_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (jurisdiction_id, source, external_id)
);
create index if not exists str_permits_geom_gix on str_permits using gist(geom);
create index if not exists str_permits_blocking_idx on str_permits(jurisdiction_id, is_blocking);

create table if not exists market_exclusions (
  jurisdiction_id text primary key references jurisdictions(id) on delete cascade,
  rules_version text not null,
  spacing_ft int not null,
  geom geometry(MultiPolygon,4326) not null,
  parcel_count int not null default 0,
  permit_count int not null default 0,
  area_sq_mi double precision,
  computed_at timestamptz not null default now()
);
create index if not exists exclusions_geom_gix on market_exclusions using gist(geom);

-- ───────────────────────────── properties & listings ────────────────────────
create table if not exists properties (
  id bigserial primary key,
  market_id text not null references markets(id) on delete cascade,
  parcel_id bigint references parcels(id),
  address text not null,
  address_norm text,
  zip text,
  lat double precision not null,
  lng double precision not null,
  geom geometry(Point,4326),
  beds int, baths numeric, sqft int, lot_sqft int, year_built int,
  property_type text, stories int,
  garage boolean, pool boolean, basement boolean, finished_basement boolean,
  hoa_status text not null default 'HOA_UNKNOWN',   -- VERIFIED_NO_HOA | HOA_PRESENT | HOA_UNKNOWN
  hoa_fee_monthly int,
  hoa_name text,
  parcel_match_confidence numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists properties_geom_gix on properties using gist(geom);
create index if not exists properties_market_idx on properties(market_id);

create table if not exists listings (
  id bigserial primary key,
  property_id bigint not null references properties(id) on delete cascade,
  market_id text not null references markets(id) on delete cascade,
  provider text not null,                   -- 'csv' | 'json' | 'reso' | ...
  external_id text not null,
  status text not null default 'active',    -- active | pending | sold | removed
  list_price bigint,
  original_price bigint,
  days_on_market int,
  listed_at date,
  url text,
  primary_photo text,
  description text,
  brokerage text,
  agent text,
  raw jsonb,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  removed_at timestamptz,
  unique (market_id, provider, external_id)
);
create index if not exists listings_active_idx on listings(market_id, status, removed_at);

create table if not exists listing_price_history (
  id bigserial primary key,
  listing_id bigint not null references listings(id) on delete cascade,
  price bigint not null,
  observed_at timestamptz not null default now(),
  source text
);
create index if not exists lph_listing_idx on listing_price_history(listing_id, observed_at desc);

create table if not exists property_features (
  id bigserial primary key,
  property_id bigint not null references properties(id) on delete cascade,
  feature_key text not null,                -- 'pool' | 'hot_tub' | 'game_room' | ...
  present boolean,
  value text,
  source text,
  observed_at timestamptz not null default now(),
  unique (property_id, feature_key)
);

create table if not exists hoa_verifications (
  id bigserial primary key,
  property_id bigint not null references properties(id) on delete cascade,
  status text not null,                     -- VERIFIED_NO_HOA | HOA_PRESENT | HOA_UNKNOWN
  fee_monthly int,
  hoa_name text,
  method text,                              -- 'listing_field' | 'deed_search' | 'agent_confirmed' | 'manual'
  evidence text,
  verified_by uuid references auth.users(id),
  verified_at timestamptz not null default now()
);

-- ───────────────────────────── Sixgen history ───────────────────────────────
create table if not exists sixgen_properties (
  id bigserial primary key,
  market_id text references markets(id),
  name text not null,
  address text,
  beds int, baths numeric, max_guests int, sqft int,
  pool boolean, hot_tub boolean, game_room boolean, theater boolean,
  amenities text[],
  external_ids jsonb,                        -- {guesty:'...', airbnb:'...'}
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create table if not exists sixgen_monthly_performance (
  id bigserial primary key,
  sixgen_property_id bigint not null references sixgen_properties(id) on delete cascade,
  year int not null, month int not null,
  gross_revenue numeric, occupied_nights int, available_nights int,
  occupancy numeric, adr numeric, revpar numeric,
  avg_lead_time_days numeric, avg_los numeric,
  import_id bigint,
  created_at timestamptz not null default now(),
  unique (sixgen_property_id, year, month, import_id)
);
create table if not exists sixgen_annual_performance (
  id bigserial primary key,
  sixgen_property_id bigint not null references sixgen_properties(id) on delete cascade,
  year int not null,
  gross_revenue numeric, occupied_nights int, available_nights int,
  occupancy numeric, adr numeric, revpar numeric,
  import_id bigint,
  created_at timestamptz not null default now(),
  unique (sixgen_property_id, year, import_id)
);

-- ───────────────────────────── analysis ─────────────────────────────────────
create table if not exists eligibility_checks (
  id bigserial primary key,
  property_id bigint not null references properties(id) on delete cascade,
  rules_version text not null,
  classification text not null,             -- GREEN | RED | YELLOW
  zone_code text, zoning_treatment text,
  spacing_result text,                      -- PASS | FAIL | REVIEW | DATA_REQUIRED
  nearest_str_permit_id bigint references str_permits(id),
  nearest_str_distance_ft numeric,
  density_result text,                      -- PASS | FAIL | REVIEW | DATA_REQUIRED
  density_units int, density_strs int, density_pct numeric, density_pct_after numeric, density_threshold_pct numeric,
  hoa_status text,
  parcel_match_confidence numeric,
  cup_required text,                        -- LIKELY | POSSIBLE | NOT_REQUIRED | UNKNOWN
  details jsonb,
  checked_at timestamptz not null default now()
);
create index if not exists elig_property_idx on eligibility_checks(property_id, checked_at desc);

create table if not exists eligibility_failures (
  id bigserial primary key,
  eligibility_check_id bigint not null references eligibility_checks(id) on delete cascade,
  code text not null,                       -- 'SPACING_FAIL' | 'HOA_PRESENT' | 'ZONING_PROHIBITED' | ...
  severity text not null,                   -- 'fail' | 'review'
  message text not null,
  evidence jsonb
);

create table if not exists revenue_forecasts (
  id bigserial primary key,
  property_id bigint not null references properties(id) on delete cascade,
  model_version text not null,
  scenario text not null,                   -- conservative | base | upside
  adr numeric, occupancy numeric, available_nights int default 365,
  annual_revenue numeric,
  monthly jsonb,                            -- [{month,adr,occ,revenue}]
  confidence text,                          -- HIGH | MEDIUM | LOW
  confidence_reasons text[],
  computed_at timestamptz not null default now()
);
create index if not exists forecast_property_idx on revenue_forecasts(property_id, scenario);

create table if not exists comparable_matches (
  id bigserial primary key,
  property_id bigint not null references properties(id) on delete cascade,
  sixgen_property_id bigint not null references sixgen_properties(id),
  model_version text not null,
  similarity numeric not null,
  weight numeric not null,
  reasons text[],
  computed_at timestamptz not null default now()
);

create table if not exists acquisition_scores (
  id bigserial primary key,
  property_id bigint not null references properties(id) on delete cascade,
  listing_id bigint references listings(id),
  score numeric not null,
  breakdown jsonb not null,                 -- {factor_key:{raw,normalized,weight,points}}
  weights_snapshot jsonb,
  rules_version text, model_version text,
  computed_at timestamptz not null default now()
);
create index if not exists score_property_idx on acquisition_scores(property_id, computed_at desc);

create table if not exists pro_formas (
  id bigserial primary key,
  property_id bigint not null references properties(id) on delete cascade,
  user_id uuid references auth.users(id),
  name text default 'Base',
  assumptions jsonb not null,               -- editable inputs
  results jsonb,                            -- NOI, cap rate, CoC ...
  updated_at timestamptz not null default now()
);

-- ───────────────────────────── workflow ─────────────────────────────────────
create table if not exists saved_properties (
  user_id uuid not null references auth.users(id) on delete cascade,
  property_id bigint not null references properties(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, property_id)
);
create table if not exists saved_searches (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  filters jsonb not null,
  alert_enabled boolean not null default false,
  created_at timestamptz not null default now()
);
create table if not exists acquisition_pipeline (
  id bigserial primary key,
  property_id bigint not null references properties(id) on delete cascade,
  status text not null default 'New',
  assigned_to uuid references auth.users(id),
  next_action text, follow_up_date date,
  offer_price bigint, broker_name text, broker_phone text, broker_email text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (property_id)
);
create table if not exists property_notes (
  id bigserial primary key,
  property_id bigint not null references properties(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now()
);

-- ───────────────────────────── operations ───────────────────────────────────
create table if not exists imports (
  id bigserial primary key,
  kind text not null,                       -- 'str_permits' | 'listings' | 'sixgen' | 'hoa'
  market_id text references markets(id),
  file_name text,
  column_mapping jsonb,
  row_count int default 0, matched int default 0, possible int default 0,
  unmatched int default 0, duplicates int default 0, invalid int default 0,
  status text default 'pending',            -- pending | processing | complete | failed
  actor uuid references auth.users(id),
  message text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create table if not exists import_rows (
  id bigserial primary key,
  import_id bigint not null references imports(id) on delete cascade,
  row_number int not null,
  raw jsonb not null,
  normalized jsonb,
  status text,                              -- matched | possible | unmatched | duplicate | invalid
  target_table text, target_id bigint,
  error text
);
create index if not exists import_rows_idx on import_rows(import_id, status);

create table if not exists listing_refreshes (
  id bigserial primary key,
  market_id text references markets(id),
  provider text,
  new_count int default 0, price_changes int default 0, removed int default 0,
  qualified int default 0,
  status text, message text,
  actor uuid references auth.users(id),
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create table if not exists audit_logs (
  id bigserial primary key,
  actor uuid references auth.users(id),
  action text not null,
  entity text, entity_id text,
  detail jsonb,
  created_at timestamptz not null default now()
);
create table if not exists data_errors (
  id bigserial primary key,
  category text not null,                   -- geocode | parcel_match | provider | gis | import
  entity text, entity_id text,
  message text not null,
  detail jsonb,
  resolved boolean not null default false,
  created_at timestamptz not null default now()
);

-- ───────────────────────────── RLS ──────────────────────────────────────────
create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from profiles where id = auth.uid()), false);
$$;

do $$ declare t text; begin
  for t in select unnest(array[
    'markets','jurisdictions','str_rules','scoring_weights','app_settings','profiles','allowed_emails',
    'zoning_districts','parcels','str_permits','market_exclusions','properties','listings',
    'listing_price_history','property_features','hoa_verifications','sixgen_properties',
    'sixgen_monthly_performance','sixgen_annual_performance','eligibility_checks','eligibility_failures',
    'revenue_forecasts','comparable_matches','acquisition_scores','pro_formas','saved_properties',
    'saved_searches','acquisition_pipeline','property_notes','imports','import_rows',
    'listing_refreshes','audit_logs','data_errors'])
  loop execute format('alter table %I enable row level security', t); end loop;
end $$;

-- Read access for all signed-in users on analysis/reference data
do $$ declare t text; begin
  for t in select unnest(array[
    'markets','jurisdictions','str_rules','scoring_weights','zoning_districts','parcels','str_permits',
    'market_exclusions','properties','listings','listing_price_history','property_features',
    'hoa_verifications','sixgen_properties','sixgen_monthly_performance','sixgen_annual_performance',
    'eligibility_checks','eligibility_failures','revenue_forecasts','comparable_matches',
    'acquisition_scores','acquisition_pipeline','property_notes'])
  loop
    execute format('drop policy if exists "read %s" on %I', t, t);
    execute format('create policy "read %s" on %I for select to authenticated using (true)', t, t);
  end loop;
end $$;

-- Own-row tables
drop policy if exists "own profile" on profiles;
create policy "own profile" on profiles for select to authenticated using (id = auth.uid() or is_admin());
drop policy if exists "own saved" on saved_properties;
create policy "own saved" on saved_properties for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "own searches" on saved_searches;
create policy "own searches" on saved_searches for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "own proformas" on pro_formas;
create policy "own proformas" on pro_formas for all to authenticated using (user_id = auth.uid() or user_id is null) with check (user_id = auth.uid());
drop policy if exists "write notes" on property_notes;
create policy "write notes" on property_notes for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "write pipeline" on acquisition_pipeline;
create policy "write pipeline" on acquisition_pipeline for all to authenticated using (true) with check (true);

-- Admin-only
do $$ declare t text; begin
  for t in select unnest(array['allowed_emails','app_settings','imports','import_rows','listing_refreshes','audit_logs','data_errors'])
  loop
    execute format('drop policy if exists "admin %s" on %I', t, t);
    execute format('create policy "admin %s" on %I for select to authenticated using (is_admin())', t, t);
  end loop;
end $$;
-- All other writes go through server routes with the service role (bypasses RLS by design).
