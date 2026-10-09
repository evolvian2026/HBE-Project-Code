"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { apiFetch } from "@/lib/api";
import { requireMembership } from "@/lib/institution";

const ids = z.object({ slug: z.string() });

/** Ends the institution's contract: read-only from now, records purged two years later. */
export async function endContract(formData: FormData) {
  const { slug } = ids.parse(Object.fromEntries(formData));
  const ctx = await requireMembership(slug);
  if (formData.get("confirm") !== "on")
    redirect(`/i/${slug}/records?error=${encodeURIComponent("Tick the box to confirm.")}`);
  const result = await apiFetch(`/v1/institutions/${ctx.institution.id}/contract`, {
    method: "POST",
    body: { action: "end" },
  });
  if (!result.ok) redirect(`/i/${slug}/records?error=${encodeURIComponent(result.message)}`);
  revalidatePath(`/i/${slug}`, "layout");
  redirect(`/i/${slug}/records?ended=1`);
}

/** Asks the worker for a full export of the institution's records. */
export async function startExport(formData: FormData) {
  const { slug } = ids.parse(Object.fromEntries(formData));
  const ctx = await requireMembership(slug);
  const result = await apiFetch(`/v1/institutions/${ctx.institution.id}/exports`, { method: "POST", body: {} });
  if (!result.ok) redirect(`/i/${slug}/records?error=${encodeURIComponent(result.message)}`);
  revalidatePath(`/i/${slug}/records`);
  redirect(`/i/${slug}/records?exporting=1`);
}
