"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { friendlyError, type ActionState } from "@/lib/actions";
import { requireMembership } from "@/lib/institution";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const courseSchema = z.object({
  slug: z.string(),
  code: z.string().trim().min(1, "Enter a course code").max(50),
  name: z.string().trim().min(2, "Enter a course name").max(200),
  term: z.string().trim().min(1, "Enter a term, e.g. 2026-T1").max(50),
  githubInstallationId: z
    .string()
    .uuid()
    .optional()
    .or(z.literal("").transform(() => undefined)),
});

export async function createCourse(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = courseSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { slug, code, name, term, githubInstallationId } = parsed.data;
  const { institution } = await requireMembership(slug);
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("courses")
    .insert({ institution_id: institution.id, code, name, term, github_installation_id: githubInstallationId ?? null })
    .select("id")
    .single();
  if (error) {
    return {
      ok: false,
      message: error.code === "23505" ? `${code} already exists for ${term}.` : friendlyError(error),
    };
  }
  revalidatePath(`/i/${slug}`, "layout");
  redirect(`/i/${slug}/courses/${data.id}`);
}

const memberSchema = z.object({
  slug: z.string(),
  courseId: z.string().uuid(),
  userId: z.string().uuid(),
  role: z.enum(["instructor", "ta", "student"]),
});

export async function addCourseMember(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = memberSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, message: "Choose a person and a role." };
  const { slug, courseId, userId, role } = parsed.data;
  const { institution } = await requireMembership(slug);
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("course_memberships")
    .insert({ institution_id: institution.id, course_id: courseId, user_id: userId, role });
  if (error) return { ok: false, message: error.code === "23505" ? "Already in this course." : friendlyError(error) };
  revalidatePath(`/i/${slug}/courses/${courseId}`);
  return { ok: true, message: "Added to the course." };
}

export async function removeCourseMember(formData: FormData) {
  const { slug, courseId, id } = z
    .object({ slug: z.string(), courseId: z.string().uuid(), id: z.string().uuid() })
    .parse(Object.fromEntries(formData));
  const supabase = await createSupabaseServerClient();
  await supabase.from("course_memberships").delete().eq("id", id);
  revalidatePath(`/i/${slug}/courses/${courseId}`);
}

export async function setCourseArchived(formData: FormData) {
  const { slug, courseId, archived } = z
    .object({ slug: z.string(), courseId: z.string().uuid(), archived: z.enum(["true", "false"]) })
    .parse(Object.fromEntries(formData));
  const supabase = await createSupabaseServerClient();
  await supabase
    .from("courses")
    .update({ archived_at: archived === "true" ? new Date().toISOString() : null })
    .eq("id", courseId);
  revalidatePath(`/i/${slug}`, "layout");
}
