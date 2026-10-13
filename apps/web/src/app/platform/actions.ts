"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { apiFetch } from "@/lib/api";
import { createSupabaseServerClient } from "@/lib/supabase/server";

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

/** Reopens an institution whose contract ended (a renewal): active again, nothing purged. */
export async function reopenContract(formData: FormData) {
  const institutionId = z.string().uuid().parse(formData.get("institutionId"));
  const result = await apiFetch(`/v1/institutions/${institutionId}/contract`, {
    method: "POST",
    body: { action: "reopen" },
  });
  if (!result.ok) redirect(`/platform?error=${encodeURIComponent(result.message)}`);
  revalidatePath("/platform");
  redirect("/platform");
}

const limit = z
  .string()
  .trim()
  .transform((v) => (v === "" ? null : Number(v)))
  .pipe(z.number().int().positive().nullable());

/** The operator's limits for an institution (blank: the plan's). */
export async function saveLimits(formData: FormData) {
  const parsed = z
    .object({
      institutionId: z.string().uuid(),
      maxActiveStudents: limit,
      institutionConcurrency: limit,
      monthlyRunnerMinutes: limit,
    })
    .safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect(`/platform?error=${encodeURIComponent("Limits are whole numbers above 0, or blank")}`);
  const { institutionId, ...body } = parsed.data;
  const result = await apiFetch(`/v1/platform/institutions/${institutionId}/limits`, { method: "PUT", body });
  if (!result.ok) redirect(`/platform?error=${encodeURIComponent(result.message)}`);
  revalidatePath("/platform");
  redirect("/platform?limits=saved");
}

/** The notice at the top of every page (empty: none). Super admins only (RLS). */
export async function saveBanner(formData: FormData) {
  const message = z
    .string()
    .trim()
    .max(300)
    .parse(formData.get("message") ?? "");
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("platform_settings")
    .update({ value: message })
    .eq("key", "maintenance_banner")
    .select("key")
    .single();
  if (error) redirect(`/platform?error=${encodeURIComponent("Could not save the notice.")}`);
  revalidatePath("/", "layout");
  redirect(`/platform?banner=${message ? "on" : "off"}`);
}

/** Registers a test suite version (its code is in the grader repository). */
export async function registerSuite(formData: FormData) {
  const v = z
    .object({
      institutionId: z.string(),
      key: z.string(),
      title: z.string(),
      path: z.string(),
      gitRef: z.string(),
      stackProfileId: z.string(),
    })
    .parse(Object.fromEntries(formData));
  const result = await apiFetch<{ key: string; version: number }>("/v1/platform/grader-suites", {
    method: "POST",
    body: {
      institutionId: v.institutionId || null,
      key: v.key,
      title: v.title,
      path: v.path,
      gitRef: v.gitRef || "main",
      stackProfileId: v.stackProfileId || null,
    },
  });
  if (!result.ok) redirect(`/platform?error=${encodeURIComponent(result.message)}`);
  revalidatePath("/platform");
  redirect(`/platform?suite=${encodeURIComponent(`${result.data.key} v${result.data.version}`)}`);
}
