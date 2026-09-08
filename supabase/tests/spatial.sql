-- Run in Supabase SQL editor after seed. Verifies PostGIS spacing math at the 600-ft boundary.
-- Uses a synthetic blocking permit + subject points at 599 / 601 ft (KY North feet).
begin;
insert into parcels (jurisdiction_id, source_object_id, address, geom) values
 ('lfucg', -1, 'TEST BLOCKING PARCEL', ST_Multi(ST_Transform(ST_MakeEnvelope(1568000,198000,1568100,198100,2246),4326)));
insert into str_permits (jurisdiction_id, source, external_id, address_raw, str_type, is_blocking, lat, lng, parcel_id)
 select 'lfucg','test','t1','TEST BLOCKING','unhosted',true, ST_Y(c), ST_X(c), id
 from (select id, ST_Centroid(geom) c from parcels where source_object_id=-1) p;
-- subject 599 ft east of the parcel's east edge (x=1568100) → should FAIL
select 'expect FAIL' as label, * from fn_spacing_test('lfucg', ST_Transform(ST_SetSRID(ST_MakePoint(1568100+599, 198050),2246),4326));
-- subject 601 ft east → should PASS
select 'expect PASS' as label, * from fn_spacing_test('lfucg', ST_Transform(ST_SetSRID(ST_MakePoint(1568100+601, 198050),2246),4326));
-- density without denominators → DATA_REQUIRED
select 'expect DATA_REQUIRED' as label, * from fn_density_test('lfucg', ST_Transform(ST_SetSRID(ST_MakePoint(1568100+300, 198050),2246),4326));
rollback;
