import { authorize, publishProblems, type Weights } from "@hbe/core";
import { sql, withActor, type Db } from "@hbe/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiDeps } from "../app.ts";
import { authenticate } from "../auth.ts";
import { HttpError, notFound } from "../errors.ts";

/** The actor's role in a course, if any. */
async function courseRoleOf(db: Db, courseId: string, userId: string): Promise<string | null> {
  const row = await db
    .selectFrom("course_memberships")
    .select("role")
    .where("course_id", "=", courseId)
    .where("user_id", "=", userId)
    .executeTakeFirst();
  return row?.role ?? null;
}

/** Queues repository creation; the provisioning sweep catches anything this misses. */
async function enqueueProvisioning(
  deps: Pick<ApiDeps, "db" | "queue">,
  where: { assignmentId?: string; submissionId?: string },
) {
  let query = deps.db.selectFrom("submissions").select("id").where("status", "=", "provisioning");
  if (where.assignmentId) query = query.where("assignment_id", "=", where.assignmentId);
  if (where.submissionId) query = query.where("id", "=", where.submissionId);
  for (const { id } of await query.execute()) {
    await deps.queue.send("provision-submission", { submissionId: id }, { singletonKey: `provision-${id}` });
  }
}

export async function assignmentRoutes(app: FastifyInstance, { db, verifier, queue }: ApiDeps): Promise<void> {
  /**
   * Publishes a draft: checks it is complete, marks it published and creates one submission
   * per enrolled student (repositories are provisioned by the worker).
   */
  app.post<{ Params: { assignmentId: string } }>("/v1/assignments/:assignmentId/publish", async (req) => {
    const actor = await authenticate(req, db, verifier);
    const assignmentId = z.string().uuid().parse(req.params.assignmentId);

    const a = await db
      .selectFrom("assignments as a")
      .innerJoin("courses as c", "c.id", "a.course_id")
      .innerJoin("stack_profiles as p", "p.id", "a.stack_profile_id")
      .leftJoin("github_installations as g", "g.id", "c.github_installation_id")
      .select([
        "a.id",
        "a.institution_id",
        "a.course_id",
        "a.status",
        "a.due_at",
        "a.release_at",
        "a.template_repo",
        "a.weights",
        "a.grader_suite_id",
        "p.status as profile_status",
        "c.archived_at as course_archived_at",
        "g.id as installation_id",
        "g.suspended_at",
        "g.deleted_at",
        (eb) =>
          eb
            .selectFrom("assignment_criteria")
            .select((e) => e.fn.countAll<number>().as("n"))
            .whereRef("assignment_criteria.assignment_id", "=", "a.id")
            .as("criteria_count"),
      ])
      .where("a.id", "=", assignmentId)
      .executeTakeFirst();
    if (!a) throw notFound("Assignment not found");

    authorize(actor, "manageCourse", a.institution_id, await courseRoleOf(db, a.course_id, actor.userId));

    const problems = publishProblems({
      status: a.status,
      dueAt: new Date(a.due_at),
      releaseAt: a.release_at ? new Date(a.release_at) : null,
      templateRepo: a.template_repo,
      stackProfileStatus: a.profile_status,
      courseArchived: Boolean(a.course_archived_at),
      courseInstallation: a.installation_id
        ? { suspended: Boolean(a.suspended_at), deleted: Boolean(a.deleted_at) }
        : null,
      rubricCriteriaCount: Number(a.criteria_count ?? 0),
      weights: a.weights as unknown as Weights,
      hasGraderSuite: a.grader_suite_id !== null,
    });
    if (problems.length) throw new HttpError(422, "not_ready", problems.join(" "), { problems });

    const submissionsCreated = await withActor(db, actor.userId, async (tx) => {
      const updated = await tx
        .updateTable("assignments")
        .set({ status: "published", published_at: new Date() })
        .where("id", "=", assignmentId)
        .where("status", "=", "draft")
        .returning("id")
        .executeTakeFirst();
      if (!updated) throw new HttpError(409, "already_published", "The assignment was published by someone else.");
      const { rows } = await sql<{ n: number }>`select private.ensure_submissions(${assignmentId}) as n`.execute(tx);
      return rows[0]?.n ?? 0;
    });

    await enqueueProvisioning({ db, queue }, { assignmentId }).catch((err: unknown) =>
      req.log.error({ err, assignmentId }, "failed to enqueue provisioning; the sweep will retry"),
    );
    req.log.info({ assignmentId, submissionsCreated }, "assignment published");
    return { published: true, submissionsCreated };
  });

  /** Staff retry for a submission whose repository could not be created. */
  app.post<{ Params: { submissionId: string } }>("/v1/submissions/:submissionId/retry-provisioning", async (req) => {
    const actor = await authenticate(req, db, verifier);
    const submissionId = z.string().uuid().parse(req.params.submissionId);
    const s = await db
      .selectFrom("submissions as s")
      .innerJoin("assignments as a", "a.id", "s.assignment_id")
      .select(["s.id", "s.status", "s.institution_id", "a.course_id"])
      .where("s.id", "=", submissionId)
      .executeTakeFirst();
    if (!s) throw notFound("Submission not found");
    authorize(actor, "manageCourse", s.institution_id, await courseRoleOf(db, s.course_id, actor.userId));
    if (s.status !== "provisioning_failed" && s.status !== "provisioning") {
      throw new HttpError(409, "not_failed", "This submission's repository does not need provisioning.");
    }
    await withActor(db, actor.userId, (tx) =>
      tx
        .updateTable("submissions")
        .set({ status: "provisioning", status_detail: null, provisioning_attempts: 0 })
        .where("id", "=", submissionId)
        .execute(),
    );
    await enqueueProvisioning({ db, queue }, { submissionId });
    return { retrying: true };
  });
}
