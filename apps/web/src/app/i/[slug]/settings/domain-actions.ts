"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { apiFetch } from "@/lib/api";
import { requireMembership } from "@/lib/institution";

const back = (slug: string, key: "address" | "address_error", message: string) =>
  redirect(`/i/${slug}/settings?${key}=${encodeURIComponent(message)}#address`);

/** Admins add their institution's own domain; then they set its DNS records. */
export async function addDomain(formData: FormData) {
  const v = z.object({ slug: z.string(), hostname: z.string() }).parse(Object.fromEntries(formData));
  const ctx = await requireMembership(v.slug);
  const result = await apiFetch(`/v1/institutions/${ctx.institution.id}/domain`, {
    method: "PUT",
    body: { hostname: v.hostname },
  });
  if (!result.ok) back(v.slug, "address_error", result.message);
  revalidatePath(`/i/${v.slug}/settings`);
  back(v.slug, "address", "Added. Set the DNS records below, then check.");
}

export async function checkDomain(formData: FormData) {
  const slug = z.string().parse(formData.get("slug"));
  const ctx = await requireMembership(slug);
  const result = await apiFetch<{ domain: { status: string; error: string | null } }>(
    `/v1/institutions/${ctx.institution.id}/domain/check`,
    { method: "POST" },
  );
  if (!result.ok) back(slug, "address_error", result.message);
  revalidatePath(`/i/${slug}/settings`);
  const d = result.ok ? result.data.domain : null;
  if (d?.status === "active") back(slug, "address", "Your domain is live.");
  if (d?.status === "provisioning")
    back(slug, "address", "Ownership confirmed. The domain goes live once its certificate is ready.");
  back(slug, "address_error", d?.error ?? "Not ready yet.");
}

export async function removeDomain(formData: FormData) {
  const slug = z.string().parse(formData.get("slug"));
  const ctx = await requireMembership(slug);
  const result = await apiFetch(`/v1/institutions/${ctx.institution.id}/domain`, { method: "DELETE" });
  if (!result.ok) back(slug, "address_error", result.message);
  revalidatePath(`/i/${slug}/settings`);
  back(slug, "address", "Removed. People reach your institution at its other addresses.");
}
