import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
/** Session-bound client (respects RLS). */
export function createClient() {
  const store = cookies();
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (all: { name: string; value: string; options?: any }[]) => {
        try { all.forEach(({ name, value, options }) => store.set(name, value, options)); } catch { /* RSC */ }
      },
    },
  });
}
