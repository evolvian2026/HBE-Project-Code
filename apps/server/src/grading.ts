import { computeGrade, type LatePolicy, type Weights } from "@hbe/core";
import { sql, withActor, type Db, type Json } from "@hbe/db";
import type { JobQueue } from "@hbe/queue";
import { teamSubmissionIds } from "./teams.ts";
import { notify, submissionLinks } from "./notifications.ts";

/**
 * After a grade version is released (and committed): tell the student, and queue its report.
 */
export async function announceRelease(db: Db, queue: JobQueue | undefined, gradeId: string): Promise<void> {
  const grade = await db
    .selectFrom("grades")
    .select(["submission_id", "final_score"])
    .where("id", "=", gradeId)
    .executeTakeFirst();
  const links = grade && (await submissionLinks(db, grade.submission_id));
  if (grade && links) {
    const earlier = await db
      .selectFrom("grades")
      .select("id")
      .where("submission_id", "=", grade.submission_id)
      .where("id", "!=", gradeId)
      .where("released_at", "is not", null)
      .executeTakeFirst();
    await notify(
      db,
      {
        institutionId: links.institution_id,
        userId: links.user_id,
        type: "grade_released",
        title: earlier ? `Your grade for ${links.title} was updated` : `Your grade for ${links.title} is out`,
        body: "See your grade, rubric scores and feedback.",
        link: links.assignment,
        dedupeKey: `grade:${gradeId}`,
      },
      queue,
    );
  }
  await queue?.send("grade-report", { gradeId }, { singletonKey: `report-${gradeId}` });
  await queue?.send("lms-grade-sync", { gradeId, force: false }, { singletonKey: `lms-${gradeId}` });
}

/** JSON with keys sorted, so stored and freshly computed values compare equal. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export interface Override {
  score: number;
  reason: string;
}

/**
 * Recomputes a finalized submission's grade from its inputs (graded run, rubric scores, frozen
 * process score, lateness) and stores a new version when anything changed. An override is kept
 * across recomputations until staff change or clear it (`override: null`). A grade that was
 * released stays released: its new versions are released at once. Returns the current version.
 */
export async function recomputeGrade(
  db: Db,
  submissionId: string,
  opts: { actorId: string | null; override?: Override | null; queue?: JobQueue },
) {
  let releasedVersion: string | null = null;
  const grade = await withActor(db, opts.actorId, async (tx) => {
    const s = await tx
      .selectFrom("submissions as s")
      .innerJoin("assignments as a", "a.id", "s.assignment_id")
      .select([
        "s.id",
        "s.institution_id",
        "s.user_id",
        "s.assignment_id",
        "s.final_sha",
        "s.late_days",
        "s.finalized_at",
        "s.grade_released_at",
        "a.weights",
        "a.late_policy",
      ])
      .where("s.id", "=", submissionId)
      .forUpdate("s")
      .executeTakeFirst();
    if (!s?.finalized_at) return null;

    // A team's graded run may belong to a teammate's (the lead) submission.
    const runSubmissions = await teamSubmissionIds(tx, s.id);
    const run = s.final_sha
      ? await tx
          .selectFrom("evaluation_runs")
          .select(["id", "score"])
          .where("submission_id", "in", runSubmissions)
          .where("sha", "=", s.final_sha)
          .where("status", "=", "completed")
          .where("score", "is not", null)
          // Prefer the deadline run or a re-grade; any finished run on the graded commit will do.
          .orderBy(sql`trigger in ('deadline', 'regrade')`, "desc")
          .orderBy("finished_at", "desc")
          .limit(1)
          .executeTakeFirst()
      : undefined;
    const { rows: rubricRows } = await sql<{ criteria: number; max_points: string; scored: number; points: string }>`
      select count(c.id)::int as criteria, coalesce(sum(c.max_points), 0) as max_points,
             count(r.id)::int as scored, coalesce(sum(r.points), 0) as points
      from assignment_criteria c
      left join rubric_scores r on r.criterion_id = c.id and r.submission_id = ${s.id}
      where c.assignment_id = ${s.assignment_id}`.execute(tx);
    const rubric = rubricRows[0]!;
    const snapshot = await tx
      .selectFrom("process_snapshots")
      .select("score")
      .where("submission_id", "=", s.id)
      .executeTakeFirst();

    const result = computeGrade({
      weights: s.weights as unknown as Weights,
      latePolicy: s.late_policy as unknown as LatePolicy,
      automated: { score: run?.score == null ? null : Number(run.score), runId: run?.id ?? null },
      rubric: {
        points: Number(rubric.points),
        maxPoints: Number(rubric.max_points),
        scored: rubric.scored,
        criteria: rubric.criteria,
      },
      process: { score: snapshot ? Number(snapshot.score) : null },
      missing: !s.final_sha,
      lateDays: s.late_days ?? 0,
    });

    const current = await tx
      .selectFrom("grades")
      .selectAll()
      .where("submission_id", "=", s.id)
      .where("is_current", "=", true)
      .forUpdate()
      .executeTakeFirst();
    const override =
      opts.override !== undefined
        ? opts.override
        : current?.override_score != null
          ? { score: Number(current.override_score), reason: current.override_reason ?? "" }
          : null;
    const components = { ...result.components, pending: result.pending, raw: result.raw };
    const next = {
      evaluation_run_id: run?.id ?? null,
      components: JSON.stringify(components) as Json,
      late_days: s.late_days ?? 0,
      late_penalty: String(result.latePenalty),
      computed_score: String(result.computed),
      override_score: override ? String(override.score) : null,
      override_reason: override?.reason ?? null,
      final_score: String(override?.score ?? result.computed),
      complete: result.complete,
    };

    const unchanged =
      current &&
      canonical(current.components) === canonical(components) &&
      current.evaluation_run_id === next.evaluation_run_id &&
      current.late_days === next.late_days &&
      Number(current.late_penalty) === result.latePenalty &&
      Number(current.computed_score) === result.computed &&
      (current.override_score === null ? null : Number(current.override_score)) === (override?.score ?? null) &&
      current.override_reason === next.override_reason &&
      current.complete === next.complete;
    if (unchanged) return current;

    if (current) {
      await tx.updateTable("grades").set({ is_current: false }).where("id", "=", current.id).execute();
    }
    const inserted = await tx
      .insertInto("grades")
      .values({
        institution_id: s.institution_id,
        submission_id: s.id,
        user_id: s.user_id,
        version: (current?.version ?? 0) + 1,
        ...next,
        is_current: true,
        released_at: s.grade_released_at ? new Date() : null,
        created_by: opts.actorId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    if (inserted.released_at) releasedVersion = inserted.id;
    return inserted;
  });
  if (releasedVersion) await announceRelease(db, opts.queue, releasedVersion);
  return grade;
}

export interface ReleaseResult {
  released: number;
  skipped: { submissionId: string; student: string; pending: string[] }[];
}

/**
 * Releases complete grades to students: the whole assignment, or the given submissions.
 * Incomplete grades are skipped with what they still need.
 */
export async function releaseGrades(
  db: Db,
  assignmentId: string,
  opts: { actorId: string; submissionIds?: string[]; queue?: JobQueue },
): Promise<ReleaseResult> {
  const releasedGrades: string[] = [];
  const result = await withActor(db, opts.actorId, async (tx) => {
    let query = tx
      .selectFrom("submissions as s")
      .leftJoin("grades as g", (j) => j.onRef("g.submission_id", "=", "s.id").on("g.is_current", "=", true))
      .innerJoin("profiles as p", "p.id", "s.user_id")
      .select(["s.id", "s.status", "g.id as grade_id", "g.complete", "g.components", "p.full_name", "p.email"])
      .where("s.assignment_id", "=", assignmentId)
      .where("s.finalized_at", "is not", null)
      .where("s.grade_released_at", "is", null);
    if (opts.submissionIds) query = query.where("s.id", "in", opts.submissionIds.length ? opts.submissionIds : [""]);
    const candidates = await query.forUpdate("s").execute();

    const now = new Date();
    const result: ReleaseResult = { released: 0, skipped: [] };
    for (const c of candidates) {
      if (!c.grade_id || !c.complete) {
        const pending = c.grade_id ? ((c.components as { pending?: string[] }).pending ?? []) : ["a grade"];
        result.skipped.push({ submissionId: c.id, student: c.full_name ?? c.email ?? "A student", pending });
        continue;
      }
      await tx
        .updateTable("submissions")
        .set({ grade_released_at: now, ...(c.status === "submitted" ? { status: "graded" as const } : {}) })
        .where("id", "=", c.id)
        .execute();
      await tx.updateTable("grades").set({ released_at: now }).where("id", "=", c.grade_id).execute();
      releasedGrades.push(c.grade_id);
      result.released++;
    }

    // Everything finalized is released: mark the assignment's grades as released.
    const { rows } = await sql<{ n: number }>`
      select count(*)::int as n from submissions
      where assignment_id = ${assignmentId} and (finalized_at is null or grade_released_at is null)`.execute(tx);
    if ((rows[0]?.n ?? 0) === 0) {
      await tx
        .updateTable("assignments")
        .set({ grades_released_at: now })
        .where("id", "=", assignmentId)
        .where("grades_released_at", "is", null)
        .execute();
    }
    return result;
  });
  for (const id of releasedGrades) await announceRelease(db, opts.queue, id);
  return result;
}
