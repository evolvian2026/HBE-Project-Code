"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { ActionState } from "@/lib/actions";
import { apiFetch } from "@/lib/api";
import { requireMembership } from "@/lib/institution";

/** Adds a stack profile (a new key, or the next version of one of the institution's own). */
export async function addStackProfile(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const v = z
    .object({
      slug: z.string(),
      key: z.string(),
      displayName: z.string(),
      description: z.string().optional(),
      definition: z.string(),
    })
    .parse(Object.fromEntries(formData));
  let definition: unknown;
  try {
    definition = JSON.parse(v.definition);
  } catch {
    return { ok: false, message: "The definition isn't valid JSON." };
  }
  const ctx = await requireMembership(v.slug);
  const result = await apiFetch<{ key: string; version: number }>(
    `/v1/institutions/${ctx.institution.id}/stack-profiles`,
    {
      method: "POST",
      body: { key: v.key, displayName: v.displayName, description: v.description || undefined, definition },
    },
  );
  if (!result.ok) return { ok: false, message: result.message };
  revalidatePath(`/i/${v.slug}`, "layout");
  return { ok: true, message: `Added ${result.data.key} v${result.data.version}. Teachers can pick it now.` };
}

const back = (slug: string, q: string) => redirect(`/i/${slug}/stacks?${q}`);

/** Retires or restores the institution's stack profile or test suite. */
export async function setStatus(formData: FormData) {
  const v = z
    .object({
      slug: z.string(),
      kind: z.enum(["profile", "suite"]),
      id: z.string().uuid(),
      status: z.enum(["active", "retired"]),
    })
    .parse(Object.fromEntries(formData));
  await requireMembership(v.slug);
  const result = await apiFetch(v.kind === "profile" ? `/v1/stack-profiles/${v.id}` : `/v1/grader-suites/${v.id}`, {
    method: "PATCH",
    body: { status: v.status },
  });
  if (!result.ok) back(v.slug, `error=${encodeURIComponent(result.message)}`);
  revalidatePath(`/i/${v.slug}`, "layout");
  back(v.slug, `saved=${v.status}`);
}

/** Which global stack profiles teachers may pick (the unticked ones are hidden). */
export async function saveOffered(formData: FormData) {
  const slug = z.string().parse(formData.get("slug"));
  const all = formData.getAll("global").map(String);
  const offered = new Set(formData.getAll("offered").map(String));
  const ctx = await requireMembership(slug);
  const result = await apiFetch(`/v1/institutions/${ctx.institution.id}/offered-profiles`, {
    method: "PUT",
    body: { hidden: all.filter((id) => !offered.has(id)) },
  });
  if (!result.ok) back(slug, `error=${encodeURIComponent(result.message)}`);
  revalidatePath(`/i/${slug}`, "layout");
  back(slug, "saved=offered");
}
