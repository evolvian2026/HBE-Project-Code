"use server";

import { ASSIGNMENT_SLUG_PATTERN, zonedLocalToUtc } from "@hbe/core";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { friendlyError, type ActionState } from "@/lib/actions";
import { apiFetch } from "@/lib/api";
import { requireCourse } from "@/lib/course";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const num = (min: number, max: number) => z.coerce.number().min(min).max(max);
const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Enter a date and time");

const assignmentSchema = z
  .object({
    slug: z.string(),
    courseId: z.string().uuid(),
    assignmentId: z
      .string()
      .uuid()
      .optional()
      .or(z.literal("").transform(() => undefined)),
    title: z.string().trim().min(2, "Enter a title").max(200),
    assignmentSlug: z
      .string()
      .trim()
      .regex(ASSIGNMENT_SLUG_PATTERN, "Short name: lowercase letters, digits and hyphens (2–40)"),
    stackProfileId: z.string().uuid("Choose a stack profile"),
    graderSuiteId: z.union([z.string().uuid(), z.literal("")]).transform((v) => v || null),
    onPush: z.literal("on").optional(),
    onPullRequest: z.literal("on").optional(),
    manualRuns: z.literal("on").optional(),
    templateRepo: z
      .string()
      .trim()
      .regex(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?$/, "Template repository must look like owner/name")
      .transform((v) => v || null),
    dueAt: localDateTime,
    releaseAt: z.union([localDateTime, z.literal("")]),
    runQuota: num(0, 100),
    automated: num(0, 100),
    rubric: num(0, 100),
    process: num(0, 100),
    latePerDay: num(0, 100),
    lateMaxDays: num(0, 60),
    lateGraceMinutes: num(0, 1440),
    regradeWindowDays: num(0, 60),
    spec: z.string().max(100_000),
  })
  .refine((v) => v.automated + v.rubric + v.process === 100, {
    message: "Grade weights must add up to 100",
    path: ["automated"],
  });

export async function saveAssignment(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = assignmentSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Invalid input" };
  const v = parsed.data;
  const { course, canManage, ctx } = await requireCourse(v.slug, v.courseId);
  if (!canManage) return { ok: false, message: "Only the course's instructors and institution admins can do that." };

  const dueAt = zonedLocalToUtc(v.dueAt, course.timezone);
  const releaseAt = v.releaseAt ? zonedLocalToUtc(v.releaseAt, course.timezone) : null;
  if (releaseAt && releaseAt >= dueAt) return { ok: false, message: "The release date must be before the due date." };

  const fields = {
    title: v.title,
    slug: v.assignmentSlug,
    stack_profile_id: v.stackProfileId,
    grader_suite_id: v.graderSuiteId,
    triggers: { on_push: Boolean(v.onPush), on_pull_request: Boolean(v.onPullRequest), manual: Boolean(v.manualRuns) },
    template_repo: v.templateRepo,
    due_at: dueAt.toISOString(),
    release_at: releaseAt?.toISOString() ?? null,
    run_quota_per_day: v.runQuota,
    weights: { automated: v.automated, rubric: v.rubric, process: v.process },
    late_policy: { per_day_percent: v.latePerDay, max_days: v.lateMaxDays, grace_minutes: v.lateGraceMinutes },
    regrade_window_days: v.regradeWindowDays,
    spec_md: v.spec,
  };

  const supabase = await createSupabaseServerClient();
  const result = v.assignmentId
    ? await supabase.from("assignments").update(fields).eq("id", v.assignmentId).select("id").single()
    : await supabase
        .from("assignments")
        .insert({ ...fields, institution_id: ctx.institution.id, course_id: course.id })
        .select("id")
        .single();
  if (result.error) {
    const msg =
      result.error.code === "23505"
        ? `Another assignment in this course already uses “${v.assignmentSlug}”.`
        : friendlyError(result.error);
    return { ok: false, message: msg };
  }
  revalidatePath(`/i/${v.slug}/courses/${course.id}`, "layout");
  redirect(`/i/${v.slug}/courses/${course.id}/assignments/${result.data.id}`);
}

const idsSchema = z.object({ slug: z.string(), courseId: z.string().uuid(), assignmentId: z.string().uuid() });

export async function publishAssignment(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { slug, courseId, assignmentId } = idsSchema.parse(Object.fromEntries(formData));
  const result = await apiFetch<{ submissionsCreated: number }>(`/v1/assignments/${assignmentId}/publish`, {
    method: "POST",
  });
  if (!result.ok) {
    return {
      ok: false,
      message: result.status === 422 ? "Not ready to publish yet:" : result.message,
      details: result.problems,
    };
  }
  revalidatePath(`/i/${slug}/courses/${courseId}`, "layout");
  redirect(`/i/${slug}/courses/${courseId}/assignments/${assignmentId}?published=${result.data.submissionsCreated}`);
}

export async function deleteAssignment(formData: FormData) {
  const { slug, courseId, assignmentId } = idsSchema.parse(Object.fromEntries(formData));
  const supabase = await createSupabaseServerClient();
  await supabase.from("assignments").delete().eq("id", assignmentId).eq("status", "draft");
  revalidatePath(`/i/${slug}/courses/${courseId}`, "layout");
  redirect(`/i/${slug}/courses/${courseId}`);
}

const criterionSchema = z.object({
  slug: z.string(),
  courseId: z.string().uuid(),
  assignmentId: z.string().uuid(),
  title: z.string().trim().min(2, "Name the criterion").max(200),
  description: z.string().trim().max(2000).optional(),
  maxPoints: z.coerce.number().positive("Points must be more than 0").max(1000),
});

export async function addCriterion(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = criterionSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Invalid input" };
  const v = parsed.data;
  const { ctx } = await requireCourse(v.slug, v.courseId);
  const supabase = await createSupabaseServerClient();
  const { count } = await supabase
    .from("assignment_criteria")
    .select("id", { count: "exact", head: true })
    .eq("assignment_id", v.assignmentId);
  const { error } = await supabase.from("assignment_criteria").insert({
    institution_id: ctx.institution.id,
    assignment_id: v.assignmentId,
    title: v.title,
    description: v.description || null,
    max_points: v.maxPoints,
    position: count ?? 0,
  });
  if (error) return { ok: false, message: friendlyError(error) };
  revalidatePath(`/i/${v.slug}/courses/${v.courseId}/assignments/${v.assignmentId}`);
  return { ok: true, message: "Criterion added." };
}

export async function removeCriterion(formData: FormData) {
  const { slug, courseId, assignmentId, id } = idsSchema
    .extend({ id: z.string().uuid() })
    .parse(Object.fromEntries(formData));
  const supabase = await createSupabaseServerClient();
  await supabase.from("assignment_criteria").delete().eq("id", id);
  revalidatePath(`/i/${slug}/courses/${courseId}/assignments/${assignmentId}`);
}

export async function retryProvisioning(formData: FormData) {
  const { slug, courseId, assignmentId, submissionId } = idsSchema
    .extend({ submissionId: z.string().uuid() })
    .parse(Object.fromEntries(formData));
  await apiFetch(`/v1/submissions/${submissionId}/retry-provisioning`, { method: "POST" });
  revalidatePath(`/i/${slug}/courses/${courseId}/assignments/${assignmentId}`);
}

/** Starts a test run (students: on their latest push, within the daily quota). */
export async function startRun(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { slug, courseId, assignmentId, submissionId } = idsSchema
    .extend({ submissionId: z.string().uuid() })
    .parse(Object.fromEntries(formData));
  const result = await apiFetch<{ runId: string }>(`/v1/submissions/${submissionId}/runs`, { method: "POST" });
  if (!result.ok) return { ok: false, message: result.message };
  const submission = `/i/${slug}/courses/${courseId}/assignments/${assignmentId}/submissions/${submissionId}`;
  revalidatePath(`/i/${slug}/courses/${courseId}/assignments/${assignmentId}`, "layout");
  redirect(`${submission}/runs/${result.data.runId}`);
}

const extensionSchema = idsSchema.extend({
  submissionId: z.string().uuid(),
  studentId: z.string().uuid(),
  dueAt: localDateTime,
  reason: z.string().trim().max(500).optional(),
});

/** Gives one student a later deadline (audited). A cutoff still ahead reopens their submission. */
export async function saveExtension(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = extensionSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Invalid input" };
  const v = parsed.data;
  const { course, canManage, ctx } = await requireCourse(v.slug, v.courseId);
  if (!canManage) return { ok: false, message: "Only the course's instructors and institution admins can do that." };
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("assignment_extensions").upsert(
    {
      institution_id: ctx.institution.id,
      assignment_id: v.assignmentId,
      user_id: v.studentId,
      due_at: zonedLocalToUtc(v.dueAt, course.timezone).toISOString(),
      reason: v.reason || null,
      granted_by: ctx.session.userId,
    },
    { onConflict: "assignment_id,user_id" },
  );
  if (error) return { ok: false, message: friendlyError(error) };
  revalidatePath(`/i/${v.slug}/courses/${v.courseId}/assignments/${v.assignmentId}`, "layout");
  return { ok: true, message: "Extension saved." };
}

export async function removeExtension(formData: FormData) {
  const v = idsSchema
    .extend({ submissionId: z.string().uuid(), studentId: z.string().uuid() })
    .parse(Object.fromEntries(formData));
  const supabase = await createSupabaseServerClient();
  await supabase.from("assignment_extensions").delete().eq("assignment_id", v.assignmentId).eq("user_id", v.studentId);
  revalidatePath(`/i/${v.slug}/courses/${v.courseId}/assignments/${v.assignmentId}`, "layout");
}

const submissionIdsSchema = idsSchema.extend({ submissionId: z.string().uuid() });
const submissionPath = (v: z.infer<typeof submissionIdsSchema>) =>
  `/i/${v.slug}/courses/${v.courseId}/assignments/${v.assignmentId}/submissions/${v.submissionId}`;

/** Rubric points and comments (fields points:<criterionId>, comment:<criterionId>) and feedback. */
export async function saveReview(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const v = submissionIdsSchema.parse(Object.fromEntries(formData));
  const scores: { criterionId: string; points: number | null; comment?: string }[] = [];
  for (const [key, value] of formData.entries()) {
    const id = key.startsWith("points:") ? key.slice("points:".length) : null;
    if (!id || !z.string().uuid().safeParse(id).success) continue;
    const raw = String(value).trim();
    const points = raw === "" ? null : Number(raw);
    if (points !== null && !Number.isFinite(points)) return { ok: false, message: "Points must be numbers." };
    scores.push({ criterionId: id, points, comment: String(formData.get(`comment:${id}`) ?? "") });
  }
  const result = await apiFetch<{ grade: { final_score: number; complete: boolean } | null }>(
    `/v1/submissions/${v.submissionId}/review`,
    { method: "PUT", body: { scores, feedback: String(formData.get("feedback") ?? "") } },
  );
  if (!result.ok) return { ok: false, message: result.message };
  revalidatePath(submissionPath(v));
  const g = result.data.grade;
  return {
    ok: true,
    message: g ? `Saved. Grade: ${g.final_score}${g.complete ? "" : " (incomplete)"}.` : "Saved.",
  };
}

export async function saveOverride(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const v = submissionIdsSchema
    .extend({
      score: z.union([z.coerce.number().min(0).max(100), z.literal("").transform(() => null)]),
      reason: z.string().trim().max(1000).optional(),
    })
    .safeParse(Object.fromEntries(formData));
  if (!v.success) return { ok: false, message: v.error.issues[0]?.message ?? "Invalid input" };
  const result = await apiFetch(`/v1/submissions/${v.data.submissionId}/override`, {
    method: "POST",
    body: { score: v.data.score, reason: v.data.reason },
  });
  if (!result.ok) return { ok: false, message: result.message };
  revalidatePath(submissionPath(v.data));
  return { ok: true, message: v.data.score === null ? "Override removed." : "Grade overridden." };
}

/** Releases every complete grade of the assignment to its students. */
export async function releaseAssignmentGrades(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const v = idsSchema.parse(Object.fromEntries(formData));
  const result = await apiFetch<{
    released: number;
    skipped: { submissionId: string; student: string; pending: string[] }[];
  }>(`/v1/assignments/${v.assignmentId}/release`, { method: "POST", body: {} });
  if (!result.ok) return { ok: false, message: result.message };
  revalidatePath(`/i/${v.slug}/courses/${v.courseId}/assignments/${v.assignmentId}`, "layout");
  const { released, skipped } = result.data;
  return {
    ok: skipped.length === 0,
    message: `Released ${released} grade${released === 1 ? "" : "s"}.${
      skipped.length ? ` ${skipped.length} not ready yet:` : ""
    }`,
    details: skipped.map((s) => `${s.student}: needs ${s.pending.join(", ")}`),
  };
}

const commentSchema = submissionIdsSchema.extend({
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  path: z.string().min(1).max(1000),
  line: z.coerce.number().int().positive(),
  body: z.string().trim().min(1, "Write a comment").max(5000),
});

const codePath = (v: { slug: string; courseId: string; assignmentId: string; submissionId: string }) =>
  `/i/${v.slug}/courses/${v.courseId}/assignments/${v.assignmentId}/submissions/${v.submissionId}/code`;

/** An inline comment on a line of the student's code (course staff; RLS checks it). */
export async function addReviewComment(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = commentSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Invalid input" };
  const v = parsed.data;
  const { ctx } = await requireCourse(v.slug, v.courseId);
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("review_comments").insert({
    institution_id: ctx.institution.id,
    submission_id: v.submissionId,
    sha: v.sha,
    path: v.path,
    line: v.line,
    body: v.body,
  });
  if (error) return { ok: false, message: friendlyError(error) };
  revalidatePath(codePath(v));
  redirect(`${codePath(v)}?sha=${v.sha}&path=${encodeURIComponent(v.path)}#L${v.line}`);
}

export async function deleteReviewComment(formData: FormData) {
  const v = submissionIdsSchema
    .extend({ id: z.string().uuid(), sha: z.string(), path: z.string() })
    .parse(Object.fromEntries(formData));
  const supabase = await createSupabaseServerClient();
  await supabase.from("review_comments").delete().eq("id", v.id);
  revalidatePath(codePath(v));
  redirect(`${codePath(v)}?sha=${v.sha}&path=${encodeURIComponent(v.path)}`);
}

/** The student asks for a regrade of their released grade. */
export async function requestRegrade(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const v = submissionIdsSchema.extend({ message: z.string() }).parse(Object.fromEntries(formData));
  const result = await apiFetch(`/v1/submissions/${v.submissionId}/regrade-requests`, {
    method: "POST",
    body: { message: v.message },
  });
  if (!result.ok) return { ok: false, message: result.message };
  revalidatePath(`/i/${v.slug}/courses/${v.courseId}/assignments/${v.assignmentId}`);
  return { ok: true, message: "Sent. Your instructors will look at it and reply here." };
}

export async function withdrawRegrade(formData: FormData) {
  const v = idsSchema.extend({ requestId: z.string().uuid() }).parse(Object.fromEntries(formData));
  await apiFetch(`/v1/regrade-requests/${v.requestId}/withdraw`, { method: "POST", body: {} });
  revalidatePath(`/i/${v.slug}/courses/${v.courseId}/assignments/${v.assignmentId}`);
}

/** Course staff accept or decline a regrade request, with a response for the student. */
export async function resolveRegrade(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const v = submissionIdsSchema
    .extend({ requestId: z.string().uuid(), outcome: z.enum(["accepted", "declined"]), response: z.string() })
    .safeParse(Object.fromEntries(formData));
  if (!v.success) return { ok: false, message: "Choose whether to accept or decline the request." };
  const result = await apiFetch(`/v1/regrade-requests/${v.data.requestId}/resolve`, {
    method: "POST",
    body: { outcome: v.data.outcome, response: v.data.response },
  });
  if (!result.ok) return { ok: false, message: result.message };
  revalidatePath(submissionPath(v.data));
  return { ok: true, message: `Request ${v.data.outcome}; the student has been told.` };
}
