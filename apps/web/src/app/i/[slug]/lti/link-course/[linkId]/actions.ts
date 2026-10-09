"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { apiFetch } from "@/lib/api";
import { requireMembership } from "@/lib/institution";

/** An instructor links the LMS course they launched from to one of their courses. */
export async function linkLmsCourse(formData: FormData) {
  const { slug, linkId, courseId } = z
    .object({ slug: z.string(), linkId: z.string().uuid(), courseId: z.string() })
    .parse(Object.fromEntries(formData));
  await requireMembership(slug);
  const here = `/i/${slug}/lti/link-course/${linkId}`;
  if (!courseId) redirect(`${here}?error=${encodeURIComponent("Choose a course.")}`);
  const result = await apiFetch(`/v1/lms-course-links/${linkId}/link`, { method: "POST", body: { courseId } });
  if (!result.ok) redirect(`${here}?error=${encodeURIComponent(result.message)}`);
  revalidatePath(`/i/${slug}/lms`);
  redirect(`/i/${slug}/courses/${courseId}?lms_linked=1`);
}
