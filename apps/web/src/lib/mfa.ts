import { redirect } from "next/navigation";
import { cache } from "react";
import { createSupabaseServerClient } from "./supabase/server";

export interface MfaState {
  /** Platform setting: admins must pass MFA. */
  required: boolean;
  /** This session passed MFA. */
  verified: boolean;
  /** The account has a verified authenticator, so it can be challenged. */
  enrolled: boolean;
}

export const getMfaState = cache(async (): Promise<MfaState> => {
  const supabase = await createSupabaseServerClient();
  const [{ data: aal }, { data: setting }] = await Promise.all([
    supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
    supabase.from("platform_settings").select("value").eq("key", "require_admin_mfa").maybeSingle(),
  ]);
  return {
    required: setting?.value !== false,
    verified: aal?.currentLevel === "aal2",
    enrolled: aal?.nextLevel === "aal2",
  };
});

/**
 * Admin pages call this: without a verified second factor the database withholds admin
 * powers, so send the admin to set one up, or to enter a code.
 */
export async function enforceAdminMfa(next: string): Promise<void> {
  const mfa = await getMfaState();
  if (!mfa.required || mfa.verified) return;
  const params = new URLSearchParams({ next });
  if (mfa.enrolled) redirect(`/auth/mfa?${params}`);
  params.set("setup", "required");
  redirect(`/account/security?${params}`);
}
