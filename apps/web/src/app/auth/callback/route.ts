import { NextResponse, type NextRequest } from "next/server";
import { safeNext, webConfig } from "@/lib/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * OAuth, magic-link and identity-linking redirects land here. After the session is
 * established, pending invitations for the verified email/GitHub login are accepted.
 */
export async function GET(request: NextRequest) {
  const { APP_URL } = webConfig();
  const code = request.nextUrl.searchParams.get("code");
  const next = safeNext(request.nextUrl.searchParams.get("next"));
  const providerError = request.nextUrl.searchParams.get("error_description");

  const fail = (message: string) =>
    NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(message)}`, APP_URL));
  if (providerError) return fail(providerError);
  if (!code) return fail("The sign-in link is incomplete. Try again.");

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) return fail("The sign-in link has expired or was already used.");

  const { data: accepted } = await supabase.rpc("accept_my_invitations");
  // New memberships change the token's institution claims.
  if (typeof accepted === "number" && accepted > 0) await supabase.auth.refreshSession();

  return NextResponse.redirect(new URL(next, APP_URL));
}
