import type { NextRequest } from "next/server";
import { webConfig } from "@/lib/config";
import { lookupHost } from "@/lib/hosts";
import { redirectAcross } from "@/lib/redirect";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut({ scope: "local" });
  const { APP_URL } = webConfig();
  const site = await lookupHost(request.headers.get("x-forwarded-host") ?? request.headers.get("host"));
  // On an institution's own address, sign out of the platform's address too (it signed you in here).
  return redirectAcross(new URL(site.platform ? "/login" : "/signed-out", APP_URL), 303);
}
