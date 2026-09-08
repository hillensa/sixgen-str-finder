import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
export default async function Home() {
  const { data: { user } } = await createClient().auth.getUser();
  redirect(user ? "/dashboard" : "/login");
}
