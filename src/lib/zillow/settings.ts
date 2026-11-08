import { DEFAULT_CRITERIA, ZILLOW_SETTINGS_KEY, parseCriteria, type ZillowCriteria } from "./criteria";

/** The saved Zillow criteria, falling back to the defaults when nothing is stored yet. */
export async function readCriteria(db: any): Promise<ZillowCriteria> {
  const { data } = await db.from("app_settings").select("value").eq("key", ZILLOW_SETTINGS_KEY).maybeSingle();
  const parsed = parseCriteria(data?.value ?? DEFAULT_CRITERIA);
  return parsed.ok ? parsed.value : DEFAULT_CRITERIA;
}
