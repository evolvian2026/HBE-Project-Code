"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { safeNext } from "@/lib/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type EnrollState =
  | { step: "idle"; error?: string }
  | { step: "verify"; factorId: string; qrCode: string; secret: string; error?: string };

const code = z
  .string()
  .trim()
  .regex(/^\d{6}$/, "Enter the 6-digit code from your authenticator app");

/** Starts TOTP enrolment (clearing abandoned, unverified attempts first). */
export async function startEnrollment(): Promise<EnrollState> {
  const supabase = await createSupabaseServerClient();
  const { data: factors } = await supabase.auth.mfa.listFactors();
  for (const f of factors?.all ?? []) {
    if (f.status === "unverified") await supabase.auth.mfa.unenroll({ factorId: f.id });
  }
  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: `Authenticator ${new Date().toISOString()}`,
  });
  if (error || !data) return { step: "idle", error: error?.message ?? "Could not start setup" };
  return { step: "verify", factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret };
}

export async function verifyEnrollment(_prev: string | null, formData: FormData): Promise<string | null> {
  const factorId = z.string().uuid().safeParse(formData.get("factorId"));
  if (!factorId.success) return "Start the setup again.";
  const parsed = code.safeParse(formData.get("code"));
  if (!parsed.success) return parsed.error.issues[0]?.message ?? "Invalid code";
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: factorId.data, code: parsed.data });
  if (error) return "That code didn't work. Check your device's clock and try the next code.";
  revalidatePath("/", "layout");
  const next = safeNext(formData.get("next"));
  redirect(next === "/" ? "/account/security?enabled=1" : next);
}

export async function removeFactor(formData: FormData) {
  const factorId = z.string().uuid().parse(formData.get("factorId"));
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.mfa.unenroll({ factorId });
  if (error)
    redirect(`/account/security?error=${encodeURIComponent("Verify with your authenticator first, then remove it.")}`);
  revalidatePath("/", "layout");
  redirect("/account/security?removed=1");
}

export async function verifyChallenge(_prev: string | null, formData: FormData): Promise<string | null> {
  const parsed = code.safeParse(formData.get("code"));
  if (!parsed.success) return parsed.error.issues[0]?.message ?? "Invalid code";
  const supabase = await createSupabaseServerClient();
  const { data: factors } = await supabase.auth.mfa.listFactors();
  const factor = factors?.totp.find((f) => f.status === "verified");
  if (!factor) return "No authenticator is set up for this account.";
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code: parsed.data });
  if (error) return "That code didn't work. Try the next one.";
  revalidatePath("/", "layout");
  redirect(safeNext(formData.get("next")));
}
