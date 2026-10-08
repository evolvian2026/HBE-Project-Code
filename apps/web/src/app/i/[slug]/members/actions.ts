"use server";

import { parseInviteCsv, planInvitations, type InviteRow } from "@hbe/core";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { friendlyError, type ActionState } from "@/lib/actions";
import { requireMembership } from "@/lib/institution";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { loadPlanContext } from "./data";

const MAX_CSV_BYTES = 512 * 1024;

/** Runs invitation rows through the planner and writes the result with the admin's own permissions. */
async function executeInvitations(
  slug: string,
  rows: InviteRow[],
  parseErrors: { line: number; message: string }[] = [],
): Promise<ActionState> {
  const ctx = await requireMembership(slug);
  const supabase = await createSupabaseServerClient();
  const plan = planInvitations(rows, await loadPlanContext(supabase, ctx.institution.id));
  const errors = [...parseErrors, ...plan.errors].map((e) => `Line ${e.line}: ${e.message}`);

  if (plan.invitations.length) {
    const { error } = await supabase
      .from("invitations")
      .insert(
        plan.invitations.map((i) => ({ ...i, institution_id: ctx.institution.id, invited_by: ctx.session.userId })),
      );
    if (error) return { ok: false, message: friendlyError(error), details: errors };
  }
  if (plan.courseMemberships.length) {
    const { error } = await supabase
      .from("course_memberships")
      .insert(plan.courseMemberships.map((m) => ({ ...m, institution_id: ctx.institution.id })));
    if (error) return { ok: false, message: friendlyError(error), details: errors };
  }

  revalidatePath(`/i/${slug}/members`);
  revalidatePath(`/i/${slug}/courses`, "layout");
  const done = [
    plan.invitations.length && `${plan.invitations.length} invited`,
    plan.courseMemberships.length && `${plan.courseMemberships.length} added to courses`,
    plan.skipped.length && `${plan.skipped.length} skipped`,
    errors.length && `${errors.length} with errors`,
  ].filter(Boolean);
  const details = [...errors, ...plan.skipped.map((s) => `Line ${s.line}: ${s.who} skipped (${s.reason})`)];
  return { ok: errors.length === 0, message: done.length ? `Done: ${done.join(", ")}.` : "Nothing to do.", details };
}

const inviteSchema = z.object({
  slug: z.string(),
  identifier: z.string().trim().min(1, "Enter an email address or GitHub username"),
  role: z.string(),
  courseId: z
    .string()
    .uuid()
    .optional()
    .or(z.literal("").transform(() => undefined)),
  courseRole: z
    .string()
    .optional()
    .transform((v) => v || undefined),
});

export async function inviteMember(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = inviteSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { slug, identifier, role, courseId, courseRole } = parsed.data;
  const isEmail = identifier.includes("@") && !identifier.startsWith("@");
  return executeInvitations(slug, [
    {
      line: 1,
      email: isEmail ? identifier : undefined,
      githubLogin: isEmail ? undefined : identifier,
      role,
      courseId,
      courseRole,
    },
  ]);
}

export async function importInvitations(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const slug = z.string().parse(formData.get("slug"));
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, message: "Choose a CSV file to import." };
  if (file.size > MAX_CSV_BYTES) return { ok: false, message: "The file is larger than 512 KB." };
  const { rows, errors } = parseInviteCsv(await file.text());
  if (rows.length === 0)
    return { ok: false, message: "No rows to import.", details: errors.map((e) => `Line ${e.line}: ${e.message}`) };
  return executeInvitations(slug, rows, errors);
}

export async function revokeInvitation(formData: FormData) {
  const { slug, id } = z.object({ slug: z.string(), id: z.string().uuid() }).parse(Object.fromEntries(formData));
  const supabase = await createSupabaseServerClient();
  await supabase.from("invitations").delete().eq("id", id);
  revalidatePath(`/i/${slug}/members`);
}

const updateSchema = z.object({
  slug: z.string(),
  id: z.string().uuid(),
  role: z.enum(["admin", "teacher", "student"]).optional(),
  status: z.enum(["active", "deactivated"]).optional(),
});

export async function updateMember(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { slug, id, role, status } = updateSchema.parse(Object.fromEntries(formData));
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("institution_memberships")
    .update({ ...(role ? { role } : {}), ...(status ? { status } : {}) })
    .eq("id", id)
    .select("id");
  if (error) return { ok: false, message: friendlyError(error) };
  if (!data?.length) return { ok: false, message: "You don't have permission to do that." };
  revalidatePath(`/i/${slug}/members`);
  return {
    ok: true,
    message: status ? `Member ${status === "active" ? "reactivated" : "deactivated"}.` : "Role updated.",
  };
}
