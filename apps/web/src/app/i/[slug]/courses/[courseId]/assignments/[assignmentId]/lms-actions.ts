"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { apiFetch } from "@/lib/api";
import { requireMembership } from "@/lib/institution";

/** Sends the assignment's released grades (or one student's) to the linked LMS gradebooks again. */
export async function sendGradesToLms(formData: FormData) {
  const { slug, courseId, assignmentId, submissionId } = z
    .object({
      slug: z.string(),
      courseId: z.string().uuid(),
      assignmentId: z.string().uuid(),
      submissionId: z.string().uuid().optional(),
    })
    .parse(Object.fromEntries(formData));
  await requireMembership(slug);
  const page = `/i/${slug}/courses/${courseId}/assignments/${assignmentId}`;
  const result = await apiFetch<{ queued: number }>(`/v1/assignments/${assignmentId}/lms-sync`, {
    method: "POST",
    body: submissionId ? { submissionIds: [submissionId] } : {},
  });
  if (!result.ok) redirect(`${page}?lms_error=${encodeURIComponent(result.message)}#lms`);
  revalidatePath(page);
  redirect(`${page}?lms_sent=${result.data.queued}&lms_at=${Date.now()}#lms`);
}
