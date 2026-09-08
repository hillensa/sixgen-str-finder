import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import AppShell from "@/components/AppShell";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const [{ data: profile }, { data: market }] = await Promise.all([
    supabase.from("profiles").select("email,is_admin").eq("id", user.id).single(),
    supabase.from("markets").select("name").eq("active", true).order("id").limit(1).maybeSingle(),
  ]);
  return <AppShell email={profile?.email ?? user.email ?? ""} isAdmin={!!profile?.is_admin} marketName={market?.name ?? "No market configured"}>{children}</AppShell>;
}
