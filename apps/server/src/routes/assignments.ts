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

export async function assignmentRoutes(app: FastifyInstance, { db, verifier }: ApiDeps): Promise<void> {
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

    req.log.info({ assignmentId, submissionsCreated }, "assignment published");
    return { published: true, submissionsCreated };
  });
}
