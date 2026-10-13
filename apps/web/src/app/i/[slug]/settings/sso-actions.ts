"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { apiFetch } from "@/lib/api";
import { requireMembership } from "@/lib/institution";

const back = (slug: string, key: "sso" | "sso_error", message: string) =>
  redirect(`/i/${slug}/settings?${key}=${encodeURIComponent(message)}#sso`);

/** Admins ask the platform operator to turn on single sign-on (or update their request). */
export async function requestSso(formData: FormData) {
  const v = z
    .object({
      slug: z.string(),
      domains: z.string(),
      metadataUrl: z.string().trim().optional(),
      metadataXml: z.string().trim().optional(),
      joinAsStudent: z.literal("on").optional(),
    })
    .parse(Object.fromEntries(formData));
  const ctx = await requireMembership(v.slug);
  const result = await apiFetch(`/v1/institutions/${ctx.institution.id}/sso`, {
    method: "PUT",
    body: {
      domains: v.domains.split(/[\s,]+/).filter(Boolean),
      ...(v.metadataXml ? { metadataXml: v.metadataXml } : v.metadataUrl ? { metadataUrl: v.metadataUrl } : {}),
      joinAsStudent: Boolean(v.joinAsStudent),
    },
  });
  if (!result.ok) back(v.slug, "sso_error", result.message);
  revalidatePath(`/i/${v.slug}/settings`);
  back(v.slug, "sso", "Sent to the platform operator, who turns it on once they've checked your domains.");
}

export async function setSsoJoin(formData: FormData) {
  const slug = z.string().parse(formData.get("slug"));
  const ctx = await requireMembership(slug);
  const result = await apiFetch(`/v1/institutions/${ctx.institution.id}/sso`, {
    method: "PATCH",
    body: { joinAsStudent: formData.get("joinAsStudent") === "on" },
  });
  if (!result.ok) back(slug, "sso_error", result.message);
  revalidatePath(`/i/${slug}/settings`);
  back(slug, "sso", "Saved.");
}

export async function disableSso(formData: FormData) {
  const slug = z.string().parse(formData.get("slug"));
  const ctx = await requireMembership(slug);
  const result = await apiFetch(`/v1/institutions/${ctx.institution.id}/sso/disable`, { method: "POST" });
  if (!result.ok) back(slug, "sso_error", result.message);
  revalidatePath(`/i/${slug}/settings`);
  back(slug, "sso", "Single sign-on is off. People sign in with GitHub or an email link.");
}
