export type Market = {
  id: string; name: string; state: string;
  center_lat: number; center_lng: number; default_zoom: number;
  srid_feet: number; proj4: string;
};
export type Jurisdiction = {
  id: string; market_id: string; name: string; planning_contact: string | null;
  gis_str_url: string | null; gis_parcel_url: string | null; gis_zoning_url: string | null;
  gis_boundary_url: string | null; gis_address_url: string | null; gis_building_url: string | null;
};
export type StrRule = {
  id: number; jurisdiction_id: string; rule_key: string; rule_name: string;
  value_num: number | null; value_text: string | null; value_json: any;
  applicable_zoning: string[] | null; applicable_str_type: string | null;
  effective_date: string; end_date: string | null; enabled: boolean;
  source: string | null; notes: string | null; rules_version: string;
};
export type HoaStatus = "VERIFIED_NO_HOA" | "HOA_PRESENT" | "HOA_UNKNOWN";
export type Classification = "GREEN" | "RED" | "YELLOW";
export type TestResult = "PASS" | "FAIL" | "REVIEW" | "DATA_REQUIRED";

export type Property = {
  id: number; market_id: string; parcel_id: number | null;
  address: string; zip: string | null; lat: number; lng: number;
  beds: number | null; baths: number | null; sqft: number | null; lot_sqft: number | null;
  year_built: number | null; property_type: string | null;
  garage: boolean | null; pool: boolean | null; basement: boolean | null; finished_basement: boolean | null;
  hoa_status: HoaStatus; hoa_fee_monthly: number | null; hoa_name: string | null;
  parcel_match_confidence: number | null;
};
export type Listing = {
  id: number; property_id: number; market_id: string; provider: string; external_id: string;
  status: string; list_price: number | null; original_price: number | null;
  days_on_market: number | null; listed_at: string | null; url: string | null;
  primary_photo: string | null; first_seen: string; last_seen: string; removed_at: string | null;
};
export type Profile = { id: string; email: string; full_name: string | null; is_admin: boolean };

export type ParcelLookup = {
  found: boolean;
  parcel?: { id: number | null; source_object_id: number; address: string; acreage: number | null; geometry: any };
  zoning?: { zone_code: string; ordinance_url: string | null; treatment: string | null };
  source: string; fetched_at: string;
};
