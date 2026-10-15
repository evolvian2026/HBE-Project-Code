import type { NextRequest } from "next/server";
import { safeNext, webConfig } from "@/lib/config";
import { redirectAcross } from "@/lib/redirect";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * On an institution's own address: the one-time code from the platform's address becomes a
 * session here, and the person continues where they were going.
 */
export async function GET(request: NextRequest) {
  const { APP_URL, API_URL, INTERNAL_API_URL } = webConfig();
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "";
  const here = `${new URL(APP_URL).protocol}//${host}`;
  const code = request.nextUrl.searchParams.get("code");
  const next = safeNext(request.nextUrl.searchParams.get("next"));
  const fail = (message: string) => redirectAcross(new URL(`/login?error=${encodeURIComponent(message)}`, APP_URL));
  if (!code) return fail("The sign-in link is incomplete. Try again.");

  const res = await fetch(new URL("/v1/auth/handoffs/redeem", INTERNAL_API_URL ?? API_URL), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, host }),
    cache: "no-store",
  });
  if (!res.ok) return fail("The sign-in link has expired or was already used. Try again.");
  const { tokenHash } = (await res.json()) as { tokenHash: string };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: "email" });
  if (error) return fail("Signing in here didn't work. Try again.");
  const { data: accepted } = await supabase.rpc("accept_my_invitations");
  if (typeof accepted === "number" && accepted > 0) await supabase.auth.refreshSession();
  return redirectAcross(new URL(next, here));
}
