"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { apiFetch } from "@/lib/api";

const createSchema = z.object({
  name: z.string().trim().min(2, "Name is too short").max(200),
  slug: z
    .string()
    .trim()
    .optional()
    .transform((v) => v || undefined),
  adminEmail: z
    .string()
    .trim()
    .optional()
    .transform((v) => v || undefined),
});

export async function createInstitution(formData: FormData) {
  const parsed = createSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success)
    redirect(`/platform?error=${encodeURIComponent(parsed.error.issues[0]?.message ?? "Invalid input")}`);
  const result = await apiFetch<{ institution: { slug: string } }>("/v1/platform/institutions", {
    method: "POST",
    body: parsed.data,
  });
  if (!result.ok) redirect(`/platform?error=${encodeURIComponent(result.message)}`);
  revalidatePath("/platform");
  redirect(`/platform?created=${encodeURIComponent(result.data.institution.slug)}`);
}

export async function mapInstallation(formData: FormData) {
  const installationId = z.coerce.number().int().positive().parse(formData.get("installationId"));
  const institutionId = z.string().uuid().parse(formData.get("institutionId"));
  const result = await apiFetch(`/v1/platform/github-installations/${installationId}`, {
    method: "PUT",
    body: { institutionId },
  });
  if (!result.ok) redirect(`/platform?error=${encodeURIComponent(result.message)}`);
  revalidatePath("/platform");
  redirect("/platform?mapped=1");
}
