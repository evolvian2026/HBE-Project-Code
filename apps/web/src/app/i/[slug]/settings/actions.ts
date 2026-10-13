"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { ActionState } from "@/lib/actions";
import { apiFetch } from "@/lib/api";
import { requireMembership } from "@/lib/institution";

const num = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

/** Institution admins rename the institution and choose what new assignments start with. */
export async function saveInstitutionSettings(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = z
    .object({
      slug: z.string(),
      name: z.string().trim().min(2, "Enter the institution's name").max(200),
      runQuota: num(0, 100),
      automated: num(0, 100),
      rubric: num(0, 100),
      process: num(0, 100),
      latePerDay: num(0, 100),
      lateMaxDays: num(0, 60),
      lateGraceMinutes: num(0, 1440),
      regradeWindowDays: num(0, 60),
      onPush: z.literal("on").optional(),
      onPullRequest: z.literal("on").optional(),
      manualRuns: z.literal("on").optional(),
      postFeedbackToGithub: z.literal("on").optional(),
    })
    .refine((v) => v.automated + v.rubric + v.process === 100, { message: "Grade weights must add up to 100" })
    .safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Invalid input" };
  const v = parsed.data;
  const ctx = await requireMembership(v.slug);
  const result = await apiFetch(`/v1/institutions/${ctx.institution.id}/settings`, {
    method: "PUT",
    body: {
      name: v.name,
      assignmentDefaults: {
        run_quota_per_day: v.runQuota,
        weights: { automated: v.automated, rubric: v.rubric, process: v.process },
        late_policy: { per_day_percent: v.latePerDay, max_days: v.lateMaxDays, grace_minutes: v.lateGraceMinutes },
        regrade_window_days: v.regradeWindowDays,
        triggers: {
          on_push: Boolean(v.onPush),
          on_pull_request: Boolean(v.onPullRequest),
          manual: Boolean(v.manualRuns),
        },
        post_feedback_to_github: Boolean(v.postFeedbackToGithub),
      },
    },
  });
  if (!result.ok) return { ok: false, message: result.message };
  revalidatePath(`/i/${v.slug}`, "layout");
  return { ok: true, message: "Settings saved. New assignments start with these; existing ones keep theirs." };
}
