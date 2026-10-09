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

/** Posts the assignment to the course's Google Classroom classes as coursework. */
export async function postToClassroom(formData: FormData) {
  const { slug, courseId, assignmentId } = z
    .object({ slug: z.string(), courseId: z.string().uuid(), assignmentId: z.string().uuid() })
    .parse(Object.fromEntries(formData));
  await requireMembership(slug);
  const page = `/i/${slug}/courses/${courseId}/assignments/${assignmentId}`;
  const result = await apiFetch<{ posted: number; failed: { classroom: string; error: string }[] }>(
    `/v1/assignments/${assignmentId}/classroom-coursework`,
    { method: "POST", body: {} },
  );
  if (!result.ok) redirect(`${page}?lms_error=${encodeURIComponent(result.message)}#lms`);
  const failed = result.data.failed.map((f) => `${f.classroom}: ${f.error}`).join(" · ");
  revalidatePath(page);
  redirect(
    failed
      ? `${page}?lms_error=${encodeURIComponent(`Couldn't post to ${failed}`)}#lms`
      : `${page}?classroom_posted=${result.data.posted}&lms_at=${Date.now()}#lms`,
  );
}
