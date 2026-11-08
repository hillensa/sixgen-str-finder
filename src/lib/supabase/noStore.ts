/**
 * fetch for every server-side Supabase client: never served from Next's Data
 * Cache.
 *
 * Next.js patches the global fetch and, outside a request it considers dynamic,
 * caches GET responses — for a year, on disk in .next/cache/fetch-cache, and on
 * Vercel across deploys. supabase-js reads through that fetch. The health check's
 * two queries were cached this way, so it reported the September exclusion as
 * "62 days old" two months after it had been rebuilt, on every deploy. A
 * database read is never safe to replay from a cache, so this is applied to
 * every server client rather than route by route.
 */
export const noStoreFetch: typeof fetch = (input, init) => fetch(input, { ...init, cache: "no-store" });
