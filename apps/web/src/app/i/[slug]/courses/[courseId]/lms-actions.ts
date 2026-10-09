"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { apiFetch } from "@/lib/api";
import { requireMembership } from "@/lib/institution";

/** Reads an LMS course's roster now (it is also read every night). */
export async function syncLmsRoster(formData: FormData) {
  const { slug, courseId, linkId } = z
    .object({ slug: z.string(), courseId: z.string().uuid(), linkId: z.string().uuid() })
    .parse(Object.fromEntries(formData));
  await requireMembership(slug);
  const page = `/i/${slug}/courses/${courseId}`;
  const result = await apiFetch(`/v1/lms-course-links/${linkId}/roster-sync`, { method: "POST", body: {} });
  if (!result.ok) redirect(`${page}?roster_error=${encodeURIComponent(result.message)}#lms`);
  redirect(`${page}?roster=${Date.now()}#lms`);
}
