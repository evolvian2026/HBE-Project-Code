import { authorize } from "@hbe/core";
import { withActor } from "@hbe/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiDeps } from "../app.ts";
import { authenticate } from "../auth.ts";
import { conflict, notFound } from "../errors.ts";
import { queueRun } from "../evaluation.ts";
import { courseRoleOf } from "./lms.ts";

const uuid = z.string().uuid();

/**
 * Bulk re-runs (§6.2): an instructor re-runs the tests of an assignment's submissions, with
 * its suite or another version of it (say, one that fixes a broken test). Each repository is
 * tested once (a team's run belongs to its lead submission): at the graded commit once the
 * cutoff has passed (a re-grade, which updates the grade), otherwise at the latest push.
 */
export async function rerunRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const { db, verifier } = deps;

  app.post<{ Params: { assignmentId: string } }>("/v1/assignments/:assignmentId/reruns", async (req, reply) => {
    const actor = await authenticate(req, db, verifier);
    const a = await db
      .selectFrom("assignments")
      .select(["id", "institution_id", "course_id", "status", "grader_suite_id"])
      .where("id", "=", uuid.parse(req.params.assignmentId))
      .executeTakeFirst();
    if (!a) throw notFound("Assignment not found");
    authorize(actor, "manageCourse", a.institution_id, await courseRoleOf(db, a.course_id, actor.userId));
    const body = z
      .object({
        /** `unfinished`: only repositories without a finished run of their commit with this suite. */
        scope: z.enum(["all", "unfinished"]).default("all"),
        suiteId: uuid.optional(),
        /** Also use this suite version for the assignment's future runs. */
        useForAssignment: z.boolean().default(false),
      })
      .parse(req.body ?? {});
    if (a.status === "draft") throw conflict("not_published", "Publish the assignment first.");
    if (!a.grader_suite_id) throw conflict("no_tests", "This assignment has no automated tests.");

    const current = await db
      .selectFrom("grader_suites")
      .select(["id", "key"])
      .where("id", "=", a.grader_suite_id)
      .executeTakeFirstOrThrow();
    const suite = await db
      .selectFrom("grader_suites")
      .select(["id", "key", "version"])
      .where("id", "=", body.suiteId ?? current.id)
      .where("key", "=", current.key)
      .where("status", "=", "active")
      .where((eb) => eb.or([eb("institution_id", "is", null), eb("institution_id", "=", a.institution_id)]))
      .executeTakeFirst();
    if (!suite) throw notFound("That version of the test suite isn't available.");

    // One submission per repository: the team's lead (earliest), or the student's own.
    const rows = await db
      .selectFrom("submissions as s")
      .innerJoin("repositories as r", "r.id", "s.repository_id")
      .select([
        "s.id",
        "s.status",
        "s.repository_id",
        "s.finalized_at",
        "s.final_sha",
        "r.head_sha",
        "r.default_branch",
      ])
      .where("s.assignment_id", "=", a.id)
      .orderBy("s.created_at")
      .orderBy("s.id")
      .execute();
    const leads = new Map<string, (typeof rows)[number]>();
    for (const r of rows) if (!leads.has(r.repository_id!)) leads.set(r.repository_id!, r);
    const teamOf = new Map<string, string[]>();
    for (const r of rows) teamOf.set(r.repository_id!, [...(teamOf.get(r.repository_id!) ?? []), r.id]);

    const targets: { submissionId: string; sha: string; trigger: "regrade" | "manual" }[] = [];
    let skipped = 0;
    for (const [repositoryId, s] of leads) {
      let sha: string | null = null;
      if (s.finalized_at)
        sha = s.final_sha; // nothing pushed before the cutoff: nothing to grade
      else if (s.status === "active") {
        sha =
          s.head_sha ??
          (
            await db
              .selectFrom("commits")
              .select("sha")
              .where("repository_id", "=", repositoryId)
              .where("branch", "=", s.default_branch)
              .orderBy("authored_at", "desc")
              .limit(1)
              .executeTakeFirst()
          )?.sha ??
          null;
      }
      if (!sha) {
        skipped++;
        continue;
      }
      // Already tested (or being tested) at this commit with this suite?
      const existing = await db
        .selectFrom("evaluation_runs")
        .select("status")
        .where("submission_id", "in", teamOf.get(repositoryId)!)
        .where("sha", "=", sha)
        .where("grader_suite_id", "=", suite.id)
        .where(
          "status",
          "in",
          body.scope === "unfinished"
            ? ["queued", "dispatched", "running", "completed"]
            : ["queued", "dispatched", "running"],
        )
        .executeTakeFirst();
      if (existing) {
        skipped++;
        continue;
      }
      targets.push({ submissionId: s.id, sha, trigger: s.finalized_at ? "regrade" : "manual" });
    }

    const batch = await withActor(db, actor.userId, async (tx) => {
      if (body.useForAssignment && suite.id !== a.grader_suite_id) {
        await tx.updateTable("assignments").set({ grader_suite_id: suite.id }).where("id", "=", a.id).execute();
      }
      return tx
        .insertInto("run_batches")
        .values({
          institution_id: a.institution_id,
          assignment_id: a.id,
          requested_by: actor.userId,
          grader_suite_id: suite.id,
          scope: body.scope,
          runs: targets.length,
          skipped,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
    });
    for (const t of targets) {
      await queueRun(deps, { ...t, requestedBy: actor.userId, suiteId: suite.id, batchId: batch.id });
    }
    req.log.info({ batchId: batch.id, runs: targets.length, skipped }, "bulk re-run queued");
    return reply.code(201).send({ batchId: batch.id, runs: targets.length, skipped });
  });
}
