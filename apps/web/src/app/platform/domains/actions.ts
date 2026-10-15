"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { apiFetch } from "@/lib/api";

/** The operator has added the domain to the hosting (DNS and certificate): serve it. */
export async function markDomainLive(formData: FormData) {
  const id = z.string().uuid().parse(formData.get("domainId"));
  const result = await apiFetch(`/v1/platform/domains/${id}/live`, { method: "POST" });
  revalidatePath("/platform/domains");
  redirect(result.ok ? "/platform/domains?done=1" : `/platform/domains?error=${encodeURIComponent(result.message)}`);
}
