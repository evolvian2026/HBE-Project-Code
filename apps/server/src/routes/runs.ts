import { allowed, ForbiddenError } from "@hbe/core";
import type { Json } from "@hbe/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiDeps } from "../app.ts";
import { authenticate } from "../auth.ts";
import { HttpError, notFound } from "../errors.ts";
import { manualRunsToday, queueRun } from "../evaluation.ts";
import type { GraderAuth } from "../grader-auth.ts";

const text = (max: number) =>
  z
    .string()
    .max(max * 4)
    .transform((s) => s.slice(0, max));
const status = z.enum(["passed", "failed", "skipped", "error"]);

/** What the grader harness reports (docs/ARCHITECTURE.md §6.5), with size limits. */
const resultsSchema = z.object({
  infra_error: text(2000).nullable().default(null),
  stages: z
    .array(
      z.object({
        key: z.string().regex(/^[a-z0-9_-]{1,40}$/),
        status,
        duration_ms: z.number().int().nonnegative().default(0),
        message: text(4000).optional(),
        tests: z
          .array(
            z.object({
              id: z.string().regex(/^[\w.:/-]{1,120}$/),
              title: text(200),
              category: text(80).optional(),
              status,
              weight: z.number().min(0).max(1000).default(1),
              duration_ms: z.number().int().nonnegative().optional(),
              expected: text(2000).optional(),
              actual: text(2000).optional(),
              message: text(4000).optional(),
              hint: text(1000).optional(),
              evidence: z.record(z.string().max(40), text(8000)).optional(),
              staff_notes: text(2000).optional(),
            }),
          )
          .max(500)
          .optional(),
      }),
    )
    .max(20),
});

export async function runRoutes(app: FastifyInstance, deps: ApiDeps & { graderAuth: GraderAuth }): Promise<void> {
  const { db, verifier, graderAuth } = deps;

  /**
   * Students start a run on the head of their default branch (within the daily quota, if the
   * assignment allows manual runs); course staff on any commit, without a quota. After the
   * cutoff, staff runs are re-grades (of the graded commit unless another is given).
   */
  app.post<{ Params: { submissionId: string } }>("/v1/submissions/:submissionId/runs", async (req, reply) => {
    const actor = await authenticate(req, db, verifier);
    const submissionId = z.string().uuid().parse(req.params.submissionId);
    const body = z
      .object({
        sha: z
          .string()
          .regex(/^[0-9a-f]{40}$/)
          .optional(),
      })
      .parse(req.body ?? {});

    const s = await db
      .selectFrom("submissions as s")
      .innerJoin("assignments as a", "a.id", "s.assignment_id")
      .innerJoin("courses as c", "c.id", "a.course_id")
      .leftJoin("repositories as r", "r.id", "s.repository_id")
      .select([
        "s.id",
        "s.user_id",
        "s.status",
        "s.institution_id",
        "a.course_id",
        "a.status as assignment_status",
        "a.grader_suite_id",
        "a.triggers",
        "a.run_quota_per_day",
        "c.timezone",
        "r.id as repo_id",
        "r.default_branch",
        "r.head_sha",
        "s.final_sha",
        "s.finalized_at",
      ])
      .where("s.id", "=", submissionId)
      .executeTakeFirst();
    if (!s) throw notFound("Submission not found");

    const courseRole =
      (
        await db
          .selectFrom("course_memberships")
          .select("role")
          .where("course_id", "=", s.course_id)
          .where("user_id", "=", actor.userId)
          .executeTakeFirst()
      )?.role ?? null;
    const isStaff = allowed(actor, "actAsCourseStaff", s.institution_id, courseRole);
    const isOwner =
      s.user_id === actor.userId && actor.memberships.get(s.institution_id)?.institutionStatus === "active";
    if (!isOwner && !isStaff) throw new ForbiddenError();

    if (!s.grader_suite_id) throw new HttpError(409, "no_tests", "This assignment has no automated tests.");

    // After the cutoff the graded commit is fixed: only staff re-grade (any commit, by default the graded one).
    if (s.finalized_at) {
      if (!isStaff) throw new HttpError(409, "closed", "The deadline has passed, so your graded commit is fixed.");
      const sha = body.sha ?? s.final_sha;
      if (!sha) throw new HttpError(409, "nothing_submitted", "Nothing was pushed before the cutoff.");
      const { runId } = await queueRun(deps, {
        submissionId: s.id,
        sha,
        trigger: "regrade",
        requestedBy: actor.userId,
      });
      return reply.code(201).send({ runId });
    }

    if (s.assignment_status !== "published")
      throw new HttpError(409, "not_open", "This assignment is not open for test runs.");
    if (s.status !== "active" || !s.repo_id)
      throw new HttpError(409, "no_repository", "The repository isn't ready yet.");

    if (!isStaff) {
      if (!(s.triggers as { manual?: boolean }).manual)
        throw new HttpError(403, "manual_runs_disabled", "Tests run automatically when you push.");
      const used = await manualRunsToday(db, s.id, s.timezone);
      if (used >= s.run_quota_per_day) {
        throw new HttpError(
          429,
          "quota_exceeded",
          `You've used all ${s.run_quota_per_day} test runs for today. Pushing still runs the tests automatically.`,
        );
      }
    }

    const sha =
      (isStaff ? body.sha : undefined) ??
      s.head_sha ??
      (
        await db
          .selectFrom("commits")
          .select("sha")
          .where("repository_id", "=", s.repo_id)
          .where("branch", "=", s.default_branch)
          .orderBy("authored_at", "desc")
          .limit(1)
          .executeTakeFirst()
      )?.sha;
    if (!sha) throw new HttpError(409, "no_commits", "Push a commit to your repository first.");

    const { runId } = await queueRun(deps, { submissionId: s.id, sha, trigger: "manual", requestedBy: actor.userId });
    return reply.code(201).send({ runId });
  });

  const loadRun = async (runId: string) => {
    const run = await db
      .selectFrom("evaluation_runs")
      .select(["id", "status", "callback_token_hash", "gh_workflow_run_id"])
      .where("id", "=", z.string().uuid().parse(runId))
      .executeTakeFirst();
    if (!run) throw notFound("Run not found");
    return run;
  };

  /** Grader callback: the job has started. Binds the run to that grader job. */
  app.post<{ Params: { runId: string } }>("/v1/runs/:runId/started", async (req) => {
    const run = await loadRun(req.params.runId);
    const { workflowRunId } = await graderAuth.verify(req, run);
    if (!["dispatched", "running"].includes(run.status))
      throw new HttpError(409, "run_not_active", `Run is ${run.status}`);
    await db
      .updateTable("evaluation_runs")
      .set({ status: "running", started_at: new Date(), gh_workflow_run_id: workflowRunId ?? run.gh_workflow_run_id })
      .where("id", "=", run.id)
      .execute();
    return { ok: true };
  });

  /** Grader callback: results. Stored, then scored and reported by the worker. */
  app.post<{ Params: { runId: string } }>("/v1/runs/:runId/results", { bodyLimit: 5 * 1024 * 1024 }, async (req) => {
    const run = await loadRun(req.params.runId);
    await graderAuth.verify(req, run);
    if (!["dispatched", "running"].includes(run.status))
      throw new HttpError(409, "run_not_active", `Run is ${run.status}`);
    const results = resultsSchema.parse(req.body);

    await db.transaction().execute(async (tx) => {
      const tests = results.stages.flatMap((stage) =>
        (stage.tests ?? []).map((t) => ({
          institution_id: undefined as unknown as string, // filled below
          run_id: run.id,
          stage: stage.key,
          test_key: t.id,
          title: t.title,
          category: t.category ?? null,
          status: t.status,
          weight: String(t.weight),
          duration_ms: t.duration_ms ?? null,
          expected: t.expected ?? null,
          actual: t.actual ?? null,
          message: t.message ?? null,
          hint: t.hint ?? null,
          evidence: t.evidence ? (JSON.stringify(t.evidence) as Json) : null,
          staff_notes: t.staff_notes ?? null,
        })),
      );
      const { institution_id } = await tx
        .selectFrom("evaluation_runs")
        .select("institution_id")
        .where("id", "=", run.id)
        .executeTakeFirstOrThrow();
      await tx.deleteFrom("test_results").where("run_id", "=", run.id).execute();
      if (tests.length)
        await tx
          .insertInto("test_results")
          .values(tests.map((t) => ({ ...t, institution_id })))
          .execute();
      await tx
        .updateTable("evaluation_runs")
        .set({
          status: results.infra_error ? "infra_error" : "completed",
          error: results.infra_error,
          finished_at: new Date(),
          // Stage outcomes without the per-test detail (that lives in test_results).
          summary: JSON.stringify({
            stages: results.stages.map(({ tests: _tests, ...stage }) => stage),
          }) as Json,
        })
        .where("id", "=", run.id)
        .execute();
    });
    await deps.queue.send("score-run", { runId: run.id });
    return { ok: true };
  });
}
