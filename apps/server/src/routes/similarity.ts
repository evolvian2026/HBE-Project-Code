import { authorize } from "@hbe/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiDeps } from "../app.ts";
import { authenticate } from "../auth.ts";
import { conflict, notFound } from "../errors.ts";
import { courseRoleOf } from "./lms.ts";

const uuid = z.string().uuid();

/**
 * Similar code between an assignment's submissions (Phase 3C), for its course staff only.
 * A check compares the graded commits; it never changes a grade.
 */
export async function similarityRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const { db, verifier, queue } = deps;

  const staffAssignment = async (req: Parameters<typeof authenticate>[0], assignmentId: string) => {
    const actor = await authenticate(req, db, verifier);
    const a = await db
      .selectFrom("assignments")
      .select(["id", "institution_id", "course_id", "status"])
      .where("id", "=", uuid.parse(assignmentId))
      .executeTakeFirst();
    if (!a) throw notFound("Assignment not found");
    authorize(actor, "actAsCourseStaff", a.institution_id, await courseRoleOf(db, a.course_id, actor.userId));
    return { actor, a };
  };

  app.post<{ Params: { assignmentId: string } }>("/v1/assignments/:assignmentId/similarity", async (req, reply) => {
    const { actor, a } = await staffAssignment(req, req.params.assignmentId);
    const graded = await db
      .selectFrom("submissions")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("assignment_id", "=", a.id)
      .where("final_sha", "is not", null)
      .executeTakeFirstOrThrow();
    if (Number(graded.n) < 2) {
      throw conflict("too_few", "There's nothing to compare yet: it needs at least two graded submissions.");
    }
    const active = await db
      .selectFrom("similarity_reports")
      .select("id")
      .where("assignment_id", "=", a.id)
      .where("status", "in", ["queued", "running"])
      .executeTakeFirst();
    if (active) return reply.code(202).send({ id: active.id, status: "already_running" });
    const report = await db
      .insertInto("similarity_reports")
      .values({ institution_id: a.institution_id, assignment_id: a.id, requested_by: actor.userId })
      .returning("id")
      .executeTakeFirstOrThrow();
    await queue.send("similarity-check", { reportId: report.id }, { singletonKey: `similarity-${report.id}` });
    return reply.code(202).send({ id: report.id, status: "queued" });
  });

  /** The latest check: when, what it compared, and the similar pairs with their passages. */
  app.get<{ Params: { assignmentId: string } }>("/v1/assignments/:assignmentId/similarity", async (req) => {
    const { a } = await staffAssignment(req, req.params.assignmentId);
    const report = await db
      .selectFrom("similarity_reports")
      .selectAll()
      .where("assignment_id", "=", a.id)
      .orderBy("created_at", "desc")
      .executeTakeFirst();
    if (!report) return { report: null, pairs: [] };
    const pairs = await db
      .selectFrom("similarity_pairs")
      .select(["id", "submission_a", "submission_b", "score", "shared", "matches"])
      .where("report_id", "=", report.id)
      .orderBy("score", "desc")
      .orderBy("shared", "desc")
      .execute();

    // Who each submission is: the student, or the team's members.
    const ids = [...new Set(pairs.flatMap((p) => [p.submission_a, p.submission_b]))];
    const subs = ids.length
      ? await db
          .selectFrom("submissions as s")
          .leftJoin("teams as t", "t.id", "s.team_id")
          .select(["s.id", "s.team_id", "s.user_id", "s.final_sha", "t.name as team_name"])
          .where("s.id", "in", ids)
          .execute()
      : [];
    const teamIds = [...new Set(subs.map((s) => s.team_id).filter((t): t is string => Boolean(t)))];
    const members = await db
      .selectFrom("submissions as s")
      .innerJoin("profiles as p", "p.id", "s.user_id")
      .select(["s.id", "s.team_id", "p.full_name", "p.email"])
      .where((eb) =>
        eb.or([
          eb("s.id", "in", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]),
          ...(teamIds.length ? [eb("s.team_id", "in", teamIds)] : []),
        ]),
      )
      .where("s.assignment_id", "=", a.id)
      .execute();
    const nameOf = (m: { full_name: string | null; email: string | null }) => m.full_name || m.email || "Unknown";
    const who = (submissionId: string) => {
      const s = subs.find((x) => x.id === submissionId);
      const people = s?.team_id
        ? members.filter((m) => m.team_id === s.team_id).map(nameOf)
        : members.filter((m) => m.id === submissionId).map(nameOf);
      return { submissionId, finalSha: s?.final_sha ?? null, team: s?.team_name ?? null, people: people.sort() };
    };

    return {
      report: {
        id: report.id,
        status: report.status,
        error: report.error,
        compared: report.compared,
        skipped: report.skipped,
        starterExcluded: report.starter_excluded,
        createdAt: report.created_at,
        finishedAt: report.finished_at,
      },
      pairs: pairs.map((p) => ({
        id: p.id,
        score: Number(p.score),
        shared: p.shared,
        a: who(p.submission_a),
        b: who(p.submission_b),
        matches: p.matches,
      })),
    };
  });
}
