-- 0008 — geocoded listings
--
-- MLS exports arrive without latitude/longitude more often than not, so the
-- listings import now geocodes them (LFUCG address points first, US Census as a
-- fallback). That makes it possible for a property's pin to be *interpolated*
-- rather than surveyed, and the difference matters: a Census coordinate is
-- placed along a street centerline and can land on the neighbouring parcel,
-- which changes the 600-ft separation answer.
--
-- So the provenance is stored, and the parcel match confidence is capped by it.

alter table properties
  add column if not exists geocode_method text,
  add column if not exists geocode_confidence numeric;

comment on column properties.geocode_method is
  'How lat/lng was obtained: provider | known_property | address_point | address_point_fuzzy | census.';
comment on column properties.geocode_confidence is
  'Confidence in the coordinate itself, 0-1. Census results are interpolated and never exceed 0.7.';

-- Same signature as 0004, so no DROP is required.
--
-- Was: parcel_match_confidence = 0.95 unconditionally. A point-in-polygon hit is
-- only as good as the point, and asserting 0.95 for a pin we interpolated
-- ourselves reports a guess as a survey. MIN_PARCEL_CONFIDENCE in
-- src/lib/eligibility.ts is 0.9, so a Census pin (<= 0.7) now trips the existing
-- LOW_PARCEL_CONFIDENCE review and the property reads YELLOW rather than GREEN.
create or replace function fn_link_properties_to_parcels(p_market text)
returns int language plpgsql as $$
declare n int;
begin
  update properties pr
     set parcel_id = pc.id,
         parcel_match_confidence = least(0.95, coalesce(pr.geocode_confidence, 0.95)),
         updated_at = now()
    from parcels pc, jurisdictions j
   where pr.market_id = p_market and j.market_id = p_market and pc.jurisdiction_id = j.id
     and pr.geom is not null and ST_Intersects(pc.geom, pr.geom)
     and pr.parcel_id is distinct from pc.id;
  get diagnostics n = row_count;
  return n;
end $$;

-- Properties linked before this migration carry the old flat 0.95. Their pins
-- came from a provider coordinate (nothing else could produce one at the time),
-- so leaving them alone is correct; only rows geocoded from here on can differ.
update properties
   set geocode_method = 'provider', geocode_confidence = 1
 where geocode_method is null;
