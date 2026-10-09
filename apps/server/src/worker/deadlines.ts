import { lateDays, submissionCutoff, type LatePolicy } from "@hbe/core";
import { sql, type Db } from "@hbe/db";
import type { JobQueue } from "@hbe/queue";
import type { Settings } from "@hbe/settings";
import type { FastifyBaseLogger } from "fastify";
import { queueRun } from "../evaluation.ts";
import { leadSubmissionId } from "../teams.ts";
import { computeSubmissionProcess } from "./activity.ts";

export interface DeadlineDeps {
  db: Db;
  queue: JobQueue;
  settings: Settings;
  log: FastifyBaseLogger;
}

/**
 * Fixes the graded commit of every submission whose cutoff has passed (the student's deadline,
 * extended if they have an extension, plus the grace period and any late window): the default
 * branch's head as of the cutoff, by GitHub's push time, ignoring pushes by bots. A push after
 * the deadline and grace period is late. Then the process score is frozen and the deadline run
 * (the graded run) is queued.
 */
export async function finalizeDueSubmissions(deps: DeadlineDeps, now = new Date()): Promise<number> {
  const { db, log } = deps;
  const { rows: due } = await sql<{
    id: string;
    repository_id: string | null;
    grader_suite_id: string | null;
    late_policy: LatePolicy;
    deadline: Date;
  }>`
    select s.id, s.repository_id, a.grader_suite_id, a.late_policy, coalesce(x.due_at, a.due_at) as deadline
    from submissions s
    join assignments a on a.id = s.assignment_id
    left join assignment_extensions x on x.assignment_id = a.id and x.user_id = s.user_id
    where s.finalized_at is null
      and a.status in ('published', 'closed')
      and coalesce(x.due_at, a.due_at) + make_interval(
            days => coalesce((a.late_policy->>'max_days')::int, 0),
            mins => coalesce((a.late_policy->>'grace_minutes')::int, 0)) <= ${now}
    order by deadline
    limit 200`.execute(db);

  let finalized = 0;
  for (const s of due) {
    const deadline = new Date(s.deadline);
    const cutoff = submissionCutoff(deadline, s.late_policy);
    const push = s.repository_id
      ? await db
          .selectFrom("branch_pushes")
          .select(["sha", "pushed_at"])
          .where("repository_id", "=", s.repository_id)
          .where("pushed_at", "<=", cutoff)
          .where("by_bot", "=", false)
          .orderBy("pushed_at", "desc")
          .orderBy("id", "desc")
          .limit(1)
          .executeTakeFirst()
      : undefined;
    const updated = await db
      .updateTable("submissions")
      .set({
        finalized_at: now,
        final_sha: push?.sha ?? null,
        submitted_at: push?.pushed_at ?? null,
        late_days: push ? lateDays(new Date(push.pushed_at), deadline, s.late_policy) : null,
        status: push ? "submitted" : "missing",
      })
      .where("id", "=", s.id)
      .where("finalized_at", "is", null)
      .executeTakeFirst();
    if (updated.numUpdatedRows === 0n) continue; // finalized concurrently
    finalized++;

    // Automatic runs still waiting would test work that no longer counts.
    await db
      .updateTable("evaluation_runs")
      .set({ status: "cancelled", error: "The deadline passed before this run started.", finished_at: now })
      .where("submission_id", "=", s.id)
      .where("status", "=", "queued")
      .where("trigger", "in", ["push", "pull_request"])
      .execute();

    await computeSubmissionProcess(deps, s.id, { final: true });
    if (push && s.grader_suite_id) {
      // A team gets one graded run of its commit (on its lead submission), which grades every member.
      const lead = await leadSubmissionId(db, s.id);
      const already = await db
        .selectFrom("evaluation_runs")
        .select("id")
        .where("submission_id", "=", lead)
        .where("sha", "=", push.sha)
        .where("trigger", "=", "deadline")
        .where("status", "not in", ["cancelled", "failed", "infra_error"])
        .executeTakeFirst();
      if (!already) await queueRun(deps, { submissionId: lead, sha: push.sha, trigger: "deadline", requestedBy: null });
    }
    // A first grade version now (missing work is complete already); the graded run updates it.
    await deps.queue.send("compute-grade", { submissionId: s.id }, { singletonKey: `grade-${s.id}` });
  }
  if (finalized) log.info({ finalized }, "submissions finalized at their deadline");
  return finalized;
}
