-- ============================================================================
--  Seed: Lexington-Fayette market + LFUCG jurisdiction + rules + weights
--  Run AFTER both migrations. Safe to re-run.
-- ============================================================================
insert into markets (id, name, state, center_lat, center_lng, default_zoom, srid_feet, proj4) values
('lexington-ky', 'Lexington, KY', 'KY', 38.035, -84.50, 12, 2246,
 '+proj=lcc +lat_1=38.96666666666667 +lat_2=37.96666666666667 +lat_0=37.5 +lon_0=-84.25 +x_0=500000.0001016001 +y_0=0 +datum=NAD83 +units=us-ft +no_defs')
on conflict (id) do update set proj4 = excluded.proj4, srid_feet = excluded.srid_feet;

insert into jurisdictions (id, market_id, name, planning_contact, gis_str_url, gis_parcel_url, gis_zoning_url, gis_boundary_url, gis_address_url, gis_building_url) values
('lfucg', 'lexington-ky', 'Lexington-Fayette Urban County Government', 'Division of Planning, 101 E Vine St, Lexington KY 40507',
 'https://services1.arcgis.com/Mg7DLdfYcSWIaDnu/arcgis/rest/services/Short_Term_Rental_Public_view/FeatureServer/0',
 'https://services1.arcgis.com/Mg7DLdfYcSWIaDnu/arcgis/rest/services/Parcel/FeatureServer/0',
 'https://services1.arcgis.com/Mg7DLdfYcSWIaDnu/arcgis/rest/services/Zoning/FeatureServer/0',
 'https://services1.arcgis.com/Mg7DLdfYcSWIaDnu/arcgis/rest/services/Fayette_County/FeatureServer/0',
 'https://services1.arcgis.com/Mg7DLdfYcSWIaDnu/arcgis/rest/services/Address_Point/FeatureServer/0',
 'https://services1.arcgis.com/Mg7DLdfYcSWIaDnu/arcgis/rest/services/Building/FeatureServer/0')
on conflict (id) do update set gis_str_url = excluded.gis_str_url, gis_parcel_url = excluded.gis_parcel_url,
  gis_zoning_url = excluded.gis_zoning_url, gis_address_url = excluded.gis_address_url;

-- ---- STR rules (versioned; edit in Admin → STR Rules) ----
-- Only rules with direct evidence are ENABLED. Others are seeded disabled with a note.
insert into str_rules (jurisdiction_id, rule_key, rule_name, value_num, applicable_str_type, enabled, source, notes, rules_version) values
('lfucg','spacing_ft','Minimum separation between un-hosted STRs (ft)',600,'unhosted',true,
 'LFUCG Zoning Ordinance Art. 8 / ZOTA 2023 (verify current text)','Measured property line to property line. Evidence: city STR layer + ordinance summary.','v2026.09'),
('lfucg','density_radius_ft','Density test radius (ft)',1000,'unhosted',false,
 'LFUCG Zoning Ordinance (confirm)','DISABLED until threshold is confirmed with LFUCG Planning. Enabling requires dwelling-unit denominators.','v2026.09'),
('lfucg','density_max_pct','Max un-hosted STR share of dwelling units within radius (%)',null,'unhosted',false,
 'LFUCG Zoning Ordinance (confirm)','Value intentionally blank — set after confirming ordinance. App returns DATA REQUIRED while blank.','v2026.09'),
('lfucg','occupancy_ceiling','Max modeled occupancy for revenue forecasts',0.82,null,true,
 'Sixgen underwriting policy','Model cap, not a legal rule. Sixgen portfolio tops out ~74%.','v2026.09'),
('lfucg','max_guests_per_bedroom','Modeled guest capacity per bedroom',2,null,true,
 'Sixgen underwriting policy','Used to estimate legal/marketable capacity when listing lacks it.','v2026.09')
on conflict do nothing;

-- Zoning treatment for un-hosted STRs (edit as ordinance is confirmed).
insert into str_rules (jurisdiction_id, rule_key, rule_name, value_text, applicable_zoning, applicable_str_type, enabled, source, notes, rules_version) values
('lfucg','zoning_treatment','Un-hosted STR treatment — residential zones','conditional_use',
 array['R-1A','R-1B','R-1C','R-1D','R-1E','R-1T','R-2','R-3','R-4','R-5'],'unhosted',true,
 'LFUCG ZOTA 2023 (verify)','Conditional Use Permit via Board of Adjustment is typically required in residential zones.','v2026.09'),
('lfucg','zoning_treatment','Un-hosted STR treatment — business / mixed-use','principal_use',
 array['B-1','B-2','B-2A','B-2B','B-3','B-4','MU-1','MU-2','MU-3','CC','CD','CN'],'unhosted',true,
 'LFUCG ZOTA 2023 (verify)','Generally permitted; confirm any registration requirements.','v2026.09'),
('lfucg','zoning_treatment','Un-hosted STR treatment — agricultural / rural','review',
 array['A-R','A-B','A-N','A-U','EAR-1','EAR-2','EAR-3'],'unhosted',true,
 'LFUCG rural land rules (verify)','Different rules apply outside the Urban Service Area. Manual review.','v2026.09')
on conflict do nothing;

-- ---- Acquisition score weights (sum = 1.00) ----
insert into scoring_weights (market_id, factor_key, factor_name, weight) values
('lexington-ky','revenue_yield','Revenue yield (revenue ÷ price)',0.30),
('lexington-ky','absolute_revenue','Absolute revenue potential',0.20),
('lexington-ky','comp_strength','Sixgen comparable strength',0.15),
('lexington-ky','guest_capacity','Guest capacity',0.10),
('lexington-ky','bedroom_opportunity','Bedroom opportunity',0.10),
('lexington-ky','price_efficiency','Price efficiency',0.05),
('lexington-ky','amenity_potential','Amenity potential',0.05),
('lexington-ky','location_demand','Location / demand',0.05)
on conflict (market_id, factor_key) do update set weight = excluded.weight;

-- ---- Hard acquisition filters ----
insert into app_settings (key, value) values
('acquisition_filters', '{"min_beds":4,"min_price":400000,"hoa_rule":"VERIFIED_NO_HOA_ONLY","market_id":"lexington-ky"}'),
('revenue_model_version', '"sixgen-comps-v1.0"')
on conflict (key) do update set value = excluded.value;

-- >>> FIRST ADMIN — change this to your email before running <<<
insert into allowed_emails (email, note) values ('seth@sixgenrentals.com', 'Owner / first admin')
on conflict (email) do nothing;
