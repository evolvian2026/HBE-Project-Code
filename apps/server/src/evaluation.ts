import { createHash } from "node:crypto";
import { sql, type Db } from "@hbe/db";
import type { JobQueue } from "@hbe/queue";
import type { Settings } from "@hbe/settings";

export type RunTrigger = "push" | "pull_request" | "manual" | "deadline" | "regrade";

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Creates (or, for automatic runs, refreshes) a queued evaluation run and schedules its
 * dispatch. Pushes and pull request updates are debounced: while such a run is still
 * queued, a newer one just moves it to the newer commit, so a burst costs one grader run.
 */
export async function queueRun(
  deps: { db: Db; queue: JobQueue; settings: Settings },
  input: { submissionId: string; sha: string; trigger: RunTrigger; requestedBy: string | null },
): Promise<{ runId: string; deduplicated: boolean }> {
  const { db, queue, settings } = deps;
  const submission = await db
    .selectFrom("submissions as s")
    .innerJoin("assignments as a", "a.id", "s.assignment_id")
    .select(["s.id", "s.institution_id", "a.grader_suite_id", "a.stack_profile_id"])
    .where("s.id", "=", input.submissionId)
    .executeTakeFirstOrThrow();

  const automatic = input.trigger === "push" || input.trigger === "pull_request";
  if (automatic) {
    const pending = await db
      .updateTable("evaluation_runs")
      .set({ sha: input.sha, queued_at: new Date() })
      .where("submission_id", "=", input.submissionId)
      .where("trigger", "=", input.trigger)
      .where("status", "=", "queued")
      .returning("id")
      .executeTakeFirst();
    if (pending) return { runId: pending.id, deduplicated: true };
  }

  const run = await db
    .insertInto("evaluation_runs")
    .values({
      institution_id: submission.institution_id,
      submission_id: submission.id,
      sha: input.sha,
      trigger: input.trigger,
      grader_suite_id: submission.grader_suite_id,
      stack_profile_id: submission.stack_profile_id,
      requested_by: input.requestedBy,
      callback_token_hash: null,
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  const debounce = automatic ? settings.profile.evaluation.push_debounce_seconds : 0;
  await queue.send(
    "dispatch-run",
    { runId: run.id },
    { singletonKey: `dispatch-${run.id}`, ...(debounce ? { startAfterSeconds: debounce } : {}) },
  );
  return { runId: run.id, deduplicated: false };
}

/** Manual runs started today (in the course's time zone) on these submissions (a team shares its quota). */
export async function manualRunsToday(db: Db, submissionIds: string[], timeZone: string): Promise<number> {
  if (!submissionIds.length) return 0;
  const { rows } = await sql<{ n: number }>`
    select count(*)::int as n from evaluation_runs
    where submission_id in (${sql.join(submissionIds)}) and trigger = 'manual'
      and (queued_at at time zone ${timeZone})::date = (now() at time zone ${timeZone})::date`.execute(db);
  return rows[0]?.n ?? 0;
}
