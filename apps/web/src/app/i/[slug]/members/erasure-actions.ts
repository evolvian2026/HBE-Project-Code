"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { ActionState } from "@/lib/actions";
import { apiFetch } from "@/lib/api";
import { requireMembership } from "@/lib/institution";

/** An admin erases a member's personal data in the institution. */
export async function eraseMember(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { slug, userId, mode, confirm, note } = z
    .object({
      slug: z.string(),
      userId: z.string().uuid(),
      mode: z.enum(["anonymise", "delete"]),
      confirm: z.string().optional(),
      note: z.string().max(2000).optional(),
    })
    .parse(Object.fromEntries(formData));
  if (confirm?.trim().toUpperCase() !== "ERASE") return { ok: false, message: "Type ERASE to confirm." };
  const ctx = await requireMembership(slug);
  const result = await apiFetch(`/v1/institutions/${ctx.institution.id}/erasure-requests`, {
    method: "POST",
    body: { userId, mode, note: note || undefined },
  });
  if (!result.ok) return { ok: false, message: result.message };
  revalidatePath(`/i/${slug}/members`);
  return { ok: true, message: "Erasing their personal data. It's listed under Erasure requests." };
}

/** An admin decides on a request (anonymise, delete or decline), or retries a failed one. */
export async function decideErasure(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { slug, requestId, decision, note } = z
    .object({
      slug: z.string(),
      requestId: z.string().uuid(),
      decision: z.enum(["anonymise", "delete", "reject"]),
      note: z.string().max(2000).optional(),
    })
    .parse(Object.fromEntries(formData));
  await requireMembership(slug);
  const result = await apiFetch(`/v1/erasure-requests/${requestId}/decision`, {
    method: "POST",
    body: { decision, note: note || undefined },
  });
  if (!result.ok) return { ok: false, message: result.message };
  revalidatePath(`/i/${slug}/members`);
  return { ok: true, message: decision === "reject" ? "Declined. They've been told." : "Erasing their personal data." };
}
