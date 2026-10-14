import { authorize } from "@hbe/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { assignmentAnalytics, courseAtRisk, courseCohorts } from "../analytics.ts";
import type { ApiDeps } from "../app.ts";
import { authenticate } from "../auth.ts";
import { notFound } from "../errors.ts";
import { courseRoleOf } from "./lms.ts";

/** Analytics for a course's instructors and TAs, and the institution's admins (Phase 3B). */
export async function analyticsRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const { db, verifier } = deps;

  const courseStaff = async (req: Parameters<typeof authenticate>[0], courseId: string) => {
    const actor = await authenticate(req, db, verifier);
    const course = await db
      .selectFrom("courses")
      .select(["id", "institution_id"])
      .where("id", "=", courseId)
      .executeTakeFirst();
    if (!course) throw notFound("Course not found");
    authorize(actor, "actAsCourseStaff", course.institution_id, await courseRoleOf(db, course.id, actor.userId));
  };

  app.get<{ Params: { assignmentId: string } }>("/v1/assignments/:assignmentId/analytics", async (req) => {
    const assignmentId = z.string().uuid().parse(req.params.assignmentId);
    const a = await db.selectFrom("assignments").select("course_id").where("id", "=", assignmentId).executeTakeFirst();
    if (!a) throw notFound("Assignment not found");
    await courseStaff(req, a.course_id);
    return assignmentAnalytics(db, assignmentId);
  });

  app.get<{ Params: { courseId: string } }>("/v1/courses/:courseId/at-risk", async (req) => {
    const courseId = z.string().uuid().parse(req.params.courseId);
    await courseStaff(req, courseId);
    return { students: await courseAtRisk(db, courseId) };
  });

  // Other terms' figures are aggregates (and withheld for small cohorts), so staff of this
  // term can compare with them without seeing anyone in them.
  app.get<{ Params: { courseId: string } }>("/v1/courses/:courseId/cohorts", async (req) => {
    const courseId = z.string().uuid().parse(req.params.courseId);
    await courseStaff(req, courseId);
    return courseCohorts(db, courseId);
  });
}
