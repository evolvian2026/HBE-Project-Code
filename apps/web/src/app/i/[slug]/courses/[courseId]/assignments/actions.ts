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
    template_repo: v.templateRepo,
    due_at: dueAt.toISOString(),
    release_at: releaseAt?.toISOString() ?? null,
    run_quota_per_day: v.runQuota,
    weights: { automated: v.automated, rubric: v.rubric, process: v.process },
    late_policy: { per_day_percent: v.latePerDay, max_days: v.lateMaxDays, grace_minutes: v.lateGraceMinutes },
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
