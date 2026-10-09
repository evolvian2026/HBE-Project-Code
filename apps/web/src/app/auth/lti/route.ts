import { NextResponse, type NextRequest } from "next/server";
import { safeNext, webConfig } from "@/lib/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * LMS launches land here (the api verified the launch and made a one-time sign-in token): the
 * token becomes a session, pending invitations are accepted, and the person continues to the
 * course or assignment.
 */
export async function GET(request: NextRequest) {
  const { APP_URL } = webConfig();
  const tokenHash = request.nextUrl.searchParams.get("token_hash");
  const next = safeNext(request.nextUrl.searchParams.get("next"));
  const fail = (message: string) =>
    NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(message)}`, APP_URL));
  if (!tokenHash) return fail("The link from your LMS is incomplete. Open the activity again.");

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: "email" });
  if (error) return fail("The link from your LMS has expired or was already used. Open the activity again.");

  const { data: accepted } = await supabase.rpc("accept_my_invitations");
  if (typeof accepted === "number" && accepted > 0) await supabase.auth.refreshSession();

  return NextResponse.redirect(new URL(next, APP_URL));
}
