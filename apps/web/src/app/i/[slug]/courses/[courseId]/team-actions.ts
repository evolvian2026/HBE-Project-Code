"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { apiFetch } from "@/lib/api";
import { requireMembership } from "@/lib/institution";

const base = z.object({ slug: z.string(), courseId: z.string().uuid() });
const back = (slug: string, courseId: string, params: Record<string, string> = {}) =>
  `/i/${slug}/courses/${courseId}?${new URLSearchParams(params).toString()}#teams`;

async function call(slug: string, courseId: string, path: string, method: string, body: unknown, done: string) {
  await requireMembership(slug);
  const result = await apiFetch(path, { method, body });
  if (!result.ok) redirect(back(slug, courseId, { team_error: result.message }));
  revalidatePath(`/i/${slug}/courses/${courseId}`);
  redirect(back(slug, courseId, { team_done: done }));
}

export async function createTeam(formData: FormData) {
  const { slug, courseId, name } = base.extend({ name: z.string() }).parse(Object.fromEntries(formData));
  await call(slug, courseId, `/v1/courses/${courseId}/teams`, "POST", { name }, `Team “${name.trim()}” created.`);
}

export async function deleteTeam(formData: FormData) {
  const { slug, courseId, teamId } = base.extend({ teamId: z.string().uuid() }).parse(Object.fromEntries(formData));
  await call(slug, courseId, `/v1/teams/${teamId}`, "DELETE", undefined, "Team deleted.");
}

/** Puts a student in a team (or takes them out: an empty team). */
export async function setTeam(formData: FormData) {
  const { slug, courseId, userId, teamId } = base
    .extend({ userId: z.string().uuid(), teamId: z.string() })
    .parse(Object.fromEntries(formData));
  await call(
    slug,
    courseId,
    `/v1/courses/${courseId}/team-members/${userId}`,
    "PUT",
    { teamId: teamId || null },
    teamId ? "Added to the team." : "Removed from the team.",
  );
}

export async function autoTeams(formData: FormData) {
  const { slug, courseId, size } = base.extend({ size: z.coerce.number() }).parse(Object.fromEntries(formData));
  await call(slug, courseId, `/v1/courses/${courseId}/teams/auto`, "POST", { size }, "Teams formed.");
}
