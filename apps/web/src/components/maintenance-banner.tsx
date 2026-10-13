import { createSupabaseServerClient } from "@/lib/supabase/server";

/** The platform operator's notice (platform_settings.maintenance_banner), on every signed-in page. */
export async function MaintenanceBanner() {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("platform_settings")
    .select("value")
    .eq("key", "maintenance_banner")
    .maybeSingle();
  const message = typeof data?.value === "string" ? data.value.trim() : "";
  if (!message) return null;
  return (
    <div
      role="status"
      className="border-b border-border bg-warning-bg px-4 py-2 text-center text-sm text-warning"
      data-testid="maintenance-banner"
    >
      {message}
    </div>
  );
}
