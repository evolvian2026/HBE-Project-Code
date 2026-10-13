"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { safeNext, webConfig } from "@/lib/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";

function callbackUrl(next: string): string {
  const url = new URL("/auth/callback", webConfig().APP_URL);
  url.searchParams.set("next", next);
  return url.toString();
}

export async function signInWithGithub(formData: FormData) {
  const next = safeNext(formData.get("next"));
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "github",
    options: { redirectTo: callbackUrl(next) },
  });
  if (error || !data.url)
    redirect(`/login?error=${encodeURIComponent(error?.message ?? "GitHub sign-in is unavailable")}`);
  redirect(data.url);
}

export async function sendMagicLink(formData: FormData) {
  const next = safeNext(formData.get("next"));
  const email = z.string().trim().toLowerCase().email().safeParse(formData.get("email"));
  if (!email.success) redirect(`/login?error=${encodeURIComponent("Enter a valid email address")}`);

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: email.data,
    options: { emailRedirectTo: callbackUrl(next), shouldCreateUser: true },
  });
  if (error) redirect(`/login?error=${encodeURIComponent(error.message)}`);
  redirect(`/login?sent=${encodeURIComponent(email.data)}`);
}

/** Sign-in through the institution's identity provider, found by the email's domain. */
export async function signInWithSso(formData: FormData) {
  const next = safeNext(formData.get("next"));
  const email = z.string().trim().toLowerCase().email().safeParse(formData.get("email"));
  if (!email.success) redirect(`/login?sso=1&error=${encodeURIComponent("Enter your institution email address")}`);
  const domain = email.data.split("@")[1]!;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithSSO({ domain, options: { redirectTo: callbackUrl(next) } });
  if (error || !data?.url) {
    redirect(
      `/login?sso=1&error=${encodeURIComponent(
        `${domain} doesn't use single sign-on here. Sign in with GitHub or an email link instead.`,
      )}`,
    );
  }
  redirect(data.url);
}
