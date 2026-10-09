"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { apiFetch } from "@/lib/api";
import { requireMembership } from "@/lib/institution";

const ids = z.object({
  slug: z.string(),
  courseId: z.string().uuid(),
  assignmentId: z.string().uuid(),
  submissionId: z.string().uuid(),
});

/** A student claims commits from their repository that aren't credited to anyone. */
export async function claimCommits(formData: FormData) {
  const v = ids.extend({ note: z.string().optional() }).parse(Object.fromEntries(formData));
  const commitIds = formData.getAll("commitId").map(String);
  await requireMembership(v.slug);
  const page = `/i/${v.slug}/courses/${v.courseId}/assignments/${v.assignmentId}`;
  const result = await apiFetch<{ claimed: number }>(`/v1/submissions/${v.submissionId}/claims`, {
    method: "POST",
    body: { commitIds, note: v.note || undefined },
  });
  if (!result.ok) redirect(`${page}?claim_error=${encodeURIComponent(result.message)}#claims`);
  revalidatePath(page);
  redirect(`${page}?claimed=${result.data.claimed}#claims`);
}

/** Course staff confirm or decline a student's pending claims. */
export async function reviewClaims(formData: FormData) {
  const v = ids
    .extend({ decision: z.enum(["approve", "reject"]), rememberEmail: z.literal("on").optional() })
    .parse(Object.fromEntries(formData));
  const claimIds = formData.getAll("claimId").map(String);
  await requireMembership(v.slug);
  const page = `/i/${v.slug}/courses/${v.courseId}/assignments/${v.assignmentId}/submissions/${v.submissionId}`;
  const result = await apiFetch(`/v1/commit-claims/review`, {
    method: "POST",
    body: { claimIds, decision: v.decision, rememberEmail: Boolean(v.rememberEmail) },
  });
  if (!result.ok) redirect(`${page}?claim_error=${encodeURIComponent(result.message)}#claims`);
  revalidatePath(page);
  redirect(`${page}?claims=${v.decision === "approve" ? "approved" : "declined"}#claims`);
}
