"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { apiFetch } from "@/lib/api";
import { requireMembership } from "@/lib/institution";

/** Course staff post a submission's released feedback to its GitHub "Feedback" issue now. */
export async function postGithubFeedback(formData: FormData) {
  const v = z
    .object({
      slug: z.string(),
      courseId: z.string().uuid(),
      assignmentId: z.string().uuid(),
      submissionId: z.string().uuid(),
    })
    .parse(Object.fromEntries(formData));
  await requireMembership(v.slug);
  const page = `/i/${v.slug}/courses/${v.courseId}/assignments/${v.assignmentId}/submissions/${v.submissionId}`;
  const result = await apiFetch<{ result: string }>(`/v1/submissions/${v.submissionId}/github-feedback`, {
    method: "POST",
  });
  if (!result.ok) redirect(`${page}?github_error=${encodeURIComponent(result.message)}#github-feedback`);
  revalidatePath(page);
  redirect(`${page}?github=${result.data.result}#github-feedback`);
}
