"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { apiFetch } from "@/lib/api";
import { safeNext, webConfig } from "@/lib/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const ids = z.object({ institutionId: z.string().uuid(), slug: z.string().min(1).max(50) });

/** Starts linking a GitHub organisation, then sends the admin to GitHub to install the App. */
export async function connectGithubOrganisation(formData: FormData) {
  const { institutionId, slug } = ids.parse(Object.fromEntries(formData));
  const result = await apiFetch<{ installUrl: string }>(`/v1/institutions/${institutionId}/github/link-requests`, {
    method: "POST",
  });
  if (!result.ok) redirect(`/i/${slug}?error=${encodeURIComponent(result.error)}`);
  redirect(result.data.installUrl);
}

/** Adds a GitHub identity to the signed-in account (required before connecting an organisation). */
export async function linkGithubAccount(formData: FormData) {
  const { slug } = ids.pick({ slug: true }).parse(Object.fromEntries(formData));
  const next = safeNext(formData.get("next"));
  const supabase = await createSupabaseServerClient();
  const redirectTo = new URL("/auth/callback", webConfig().APP_URL);
  redirectTo.searchParams.set("next", next === "/" ? `/i/${slug}` : next);
  const { data, error } = await supabase.auth.linkIdentity({
    provider: "github",
    options: { redirectTo: redirectTo.toString() },
  });
  if (error || !data.url) redirect(`/i/${slug}?error=github_link_failed`);
  redirect(data.url);
}
