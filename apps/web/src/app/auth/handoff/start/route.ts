import { NextResponse, type NextRequest } from "next/server";
import { apiFetch } from "@/lib/api";
import { webConfig } from "@/lib/config";
import { redirectAcross } from "@/lib/redirect";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * On the platform's address: hands the signed-in person to an institution's own address
 * (`to`, a full URL there) with a one-time code. Signs them in here first if needed.
 */
export async function GET(request: NextRequest) {
  const { APP_URL } = webConfig();
  const to = request.nextUrl.searchParams.get("to") ?? "";
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims?.sub) {
    const login = new URL("/login", APP_URL);
    login.searchParams.set("next", `/auth/handoff/start?to=${encodeURIComponent(to)}`);
    return NextResponse.redirect(login);
  }
  const result = await apiFetch<{ url: string }>("/v1/auth/handoffs", { method: "POST", body: { to } });
  if (!result.ok) {
    return NextResponse.redirect(new URL(`/?error=${encodeURIComponent(result.message)}`, APP_URL));
  }
  return redirectAcross(result.data.url);
}
