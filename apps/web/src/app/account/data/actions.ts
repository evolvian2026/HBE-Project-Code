"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { ActionState } from "@/lib/actions";
import { apiFetch } from "@/lib/api";

/** Asks an institution's admins to erase the person's data there. */
export async function askErasure(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { institutionId, note } = z
    .object({ institutionId: z.string().uuid(), note: z.string().max(2000).optional() })
    .parse(Object.fromEntries(formData));
  const result = await apiFetch("/v1/me/erasure-requests", {
    method: "POST",
    body: { institutionId, note: note || undefined },
  });
  if (!result.ok) return { ok: false, message: result.message };
  revalidatePath("/account/data");
  return { ok: true, message: "Sent to the institution's admins. You'll be told what they decide." };
}
