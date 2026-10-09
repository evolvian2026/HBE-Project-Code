import { allowed, authorize, ForbiddenError } from "@hbe/core";
import { withActor, type Db } from "@hbe/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiDeps } from "../app.ts";
import { authenticate } from "../auth.ts";
import { HttpError, notFound } from "../errors.ts";
import { teamSubmissionIds } from "../teams.ts";
import { recomputeGrade, releaseGrades } from "../grading.ts";

async function loadSubmission(db: Db, submissionId: string) {
  const s = await db
    .selectFrom("submissions as s")
    .innerJoin("assignments as a", "a.id", "s.assignment_id")
    .select(["s.id", "s.institution_id", "s.assignment_id", "s.finalized_at", "a.course_id"])
    .where("s.id", "=", z.string().uuid().parse(submissionId))
    .executeTakeFirst();
  if (!s) throw notFound("Submission not found");
  return s;
}

async function courseRoleOf(db: Db, courseId: string, userId: string): Promise<string | null> {
  const row = await db
    .selectFrom("course_memberships")
    .select("role")
    .where("course_id", "=", courseId)
    .where("user_id", "=", userId)
    .executeTakeFirst();
  return row?.role ?? null;
}

const gradeView = <T extends { final_score: string; computed_score: string; version: number } | null>(g: T) =>
  g && { ...g, final_score: Number(g.final_score), computed_score: Number(g.computed_score) };

export async function gradingRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const { db, verifier } = deps;

  /** Course staff (instructors and TAs) score the rubric and write feedback; the grade is recomputed. */
  app.put<{ Params: { submissionId: string } }>("/v1/submissions/:submissionId/review", async (req) => {
    const actor = await authenticate(req, db, verifier);
    const s = await loadSubmission(db, req.params.submissionId);
    if (!allowed(actor, "actAsCourseStaff", s.institution_id, await courseRoleOf(db, s.course_id, actor.userId))) {
      throw new ForbiddenError();
    }
    const body = z
      .object({
        scores: z
          .array(
            z.object({
              criterionId: z.string().uuid(),
              points: z.number().min(0).max(1000).nullable(),
              comment: z.string().max(5000).optional(),
            }),
          )
          .max(100)
          .default([]),
        feedback: z.string().max(50_000).optional(),
        /** Team assignments: score the team's shared work for every member (the default). */
        wholeTeam: z.boolean().default(true),
      })
      .parse(req.body);
    const targets = body.wholeTeam ? await teamSubmissionIds(db, s.id) : [s.id];

    const criteria = new Set(
      (
        await db.selectFrom("assignment_criteria").select("id").where("assignment_id", "=", s.assignment_id).execute()
      ).map((c) => c.id),
    );
    for (const sc of body.scores) {
      if (!criteria.has(sc.criterionId)) throw new HttpError(400, "unknown_criterion", "Unknown rubric criterion.");
    }

    await withActor(db, actor.userId, async (tx) => {
      for (const submissionId of targets) {
        for (const sc of body.scores) {
          if (sc.points === null) {
            await tx
              .deleteFrom("rubric_scores")
              .where("submission_id", "=", submissionId)
              .where("criterion_id", "=", sc.criterionId)
              .execute();
            continue;
          }
          const values = {
            points: String(sc.points),
            comment: sc.comment?.trim() || null,
            scored_by: actor.userId,
            scored_at: new Date(),
          };
          await tx
            .insertInto("rubric_scores")
            .values({
              institution_id: s.institution_id,
              submission_id: submissionId,
              criterion_id: sc.criterionId,
              ...values,
            })
            .onConflict((oc) => oc.columns(["submission_id", "criterion_id"]).doUpdateSet(values))
            .execute();
        }
        if (body.feedback !== undefined) {
          const values = { body_md: body.feedback, author_id: actor.userId, updated_at: new Date() };
          await tx
            .insertInto("feedback")
            .values({ institution_id: s.institution_id, submission_id: submissionId, ...values })
            .onConflict((oc) => oc.column("submission_id").doUpdateSet(values))
            .execute();
        }
      }
    }).catch((err: { code?: string; message?: string }) => {
      if (err.code === "23514") throw new HttpError(400, "too_many_points", err.message ?? "Too many points");
      throw err;
    });

    for (const other of targets.filter((id) => id !== s.id)) {
      await recomputeGrade(db, other, { actorId: actor.userId, queue: deps.queue });
    }
    return {
      grade: gradeView(await recomputeGrade(db, s.id, { actorId: actor.userId, queue: deps.queue })),
      team: targets.length,
    };
  });

  /** Instructors (not TAs) override a final grade, with a reason; `score: null` removes the override. */
  app.post<{ Params: { submissionId: string } }>("/v1/submissions/:submissionId/override", async (req) => {
    const actor = await authenticate(req, db, verifier);
    const s = await loadSubmission(db, req.params.submissionId);
    authorize(actor, "manageCourse", s.institution_id, await courseRoleOf(db, s.course_id, actor.userId));
    const body = z
      .object({
        score: z.number().min(0).max(100).nullable(),
        reason: z.string().trim().max(1000).optional(),
      })
      .parse(req.body);
    if (body.score !== null && (body.reason ?? "").length < 5) {
      throw new HttpError(400, "reason_required", "Give a reason for the override (it's kept in the audit log).");
    }
    if (!s.finalized_at) throw new HttpError(409, "not_final", "The graded commit isn't fixed yet.");
    const grade = await recomputeGrade(db, s.id, {
      actorId: actor.userId,
      queue: deps.queue,
      override: body.score === null ? null : { score: body.score, reason: body.reason! },
    });
    return { grade: gradeView(grade) };
  });

  /** Instructors release grades to students: the whole assignment, or chosen submissions. */
  app.post<{ Params: { assignmentId: string } }>("/v1/assignments/:assignmentId/release", async (req) => {
    const actor = await authenticate(req, db, verifier);
    const assignmentId = z.string().uuid().parse(req.params.assignmentId);
    const a = await db
      .selectFrom("assignments")
      .select(["id", "institution_id", "course_id"])
      .where("id", "=", assignmentId)
      .executeTakeFirst();
    if (!a) throw notFound("Assignment not found");
    authorize(actor, "manageCourse", a.institution_id, await courseRoleOf(db, a.course_id, actor.userId));
    const body = z.object({ submissionIds: z.array(z.string().uuid()).max(1000).optional() }).parse(req.body ?? {});
    return releaseGrades(db, a.id, { actorId: actor.userId, submissionIds: body.submissionIds, queue: deps.queue });
  });
}
