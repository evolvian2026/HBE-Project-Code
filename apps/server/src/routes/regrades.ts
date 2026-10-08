import { allowed, ForbiddenError } from "@hbe/core";
import { withActor, type Db } from "@hbe/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiDeps } from "../app.ts";
import { authenticate } from "../auth.ts";
import { conflict, notFound } from "../errors.ts";
import { notify, submissionLinks } from "../notifications.ts";

const DAY_MS = 86_400_000;

async function courseRoleOf(db: Db, courseId: string, userId: string): Promise<string | null> {
  const row = await db
    .selectFrom("course_memberships")
    .select("role")
    .where("course_id", "=", courseId)
    .where("user_id", "=", userId)
    .executeTakeFirst();
  return row?.role ?? null;
}

async function loadRequest(db: Db, requestId: string) {
  const r = await db
    .selectFrom("regrade_requests as r")
    .innerJoin("submissions as s", "s.id", "r.submission_id")
    .innerJoin("assignments as a", "a.id", "s.assignment_id")
    .select(["r.id", "r.status", "r.requested_by", "r.submission_id", "s.institution_id", "s.user_id", "a.course_id"])
    .where("r.id", "=", z.string().uuid().parse(requestId))
    .executeTakeFirst();
  if (!r) throw notFound("Regrade request not found");
  return r;
}

/** When regrade requests close for a submission, or null if the assignment doesn't take them. */
export function regradeDeadline(releasedAt: Date, windowDays: number): Date | null {
  return windowDays > 0 ? new Date(releasedAt.getTime() + windowDays * DAY_MS) : null;
}

export async function regradeRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const { db, verifier } = deps;

  /** The student asks for a regrade of their released grade, within the assignment's window. */
  app.post<{ Params: { submissionId: string } }>(
    "/v1/submissions/:submissionId/regrade-requests",
    async (req, reply) => {
      const actor = await authenticate(req, db, verifier);
      const s = await db
        .selectFrom("submissions as s")
        .innerJoin("assignments as a", "a.id", "s.assignment_id")
        .innerJoin("profiles as p", "p.id", "s.user_id")
        .select([
          "s.id",
          "s.institution_id",
          "s.user_id",
          "s.grade_released_at",
          "a.course_id",
          "a.regrade_window_days",
          "p.full_name",
          "p.email",
        ])
        .where("s.id", "=", z.string().uuid().parse(req.params.submissionId))
        .executeTakeFirst();
      if (!s) throw notFound("Submission not found");
      if (s.user_id !== actor.userId || actor.memberships.get(s.institution_id)?.institutionStatus !== "active") {
        throw new ForbiddenError();
      }
      const body = z
        .object({
          message: z
            .string()
            .trim()
            .min(10, "Say what you think was graded wrongly, and why (at least 10 characters).")
            .max(2000),
        })
        .parse(req.body);
      if (!s.grade_released_at) throw conflict("not_released", "Your grade hasn't been released yet.");
      const closes = regradeDeadline(new Date(s.grade_released_at), s.regrade_window_days);
      if (!closes) throw conflict("regrades_closed", "This assignment doesn't take regrade requests.");
      if (Date.now() > closes.getTime()) {
        throw conflict("regrade_window_closed", "Regrade requests for this assignment have closed.");
      }

      const request = await withActor(db, actor.userId, (tx) =>
        tx
          .insertInto("regrade_requests")
          .values({
            institution_id: s.institution_id,
            submission_id: s.id,
            requested_by: actor.userId,
            message: body.message,
          })
          .returning(["id", "status", "created_at"])
          .executeTakeFirstOrThrow(),
      ).catch((err: { code?: string }) => {
        if (err.code === "23505") throw conflict("already_open", "You already have an open regrade request.");
        throw err;
      });

      const links = await submissionLinks(db, s.id);
      const staff = await db
        .selectFrom("course_memberships")
        .select("user_id")
        .where("course_id", "=", s.course_id)
        .where("role", "in", ["instructor", "ta"])
        .execute();
      for (const m of staff) {
        await notify(
          db,
          {
            institutionId: s.institution_id,
            userId: m.user_id,
            type: "regrade_requested",
            title: `${s.full_name ?? s.email ?? "A student"} asked for a regrade of ${links?.title ?? "an assignment"}`,
            body: body.message,
            link: links?.submission ?? null,
            dedupeKey: `regrade:${request.id}`,
          },
          deps.queue,
        );
      }
      return reply.code(201).send({ request });
    },
  );

  /** Course staff accept or decline an open request, with a response for the student. */
  app.post<{ Params: { requestId: string } }>("/v1/regrade-requests/:requestId/resolve", async (req) => {
    const actor = await authenticate(req, db, verifier);
    const r = await loadRequest(db, req.params.requestId);
    if (!allowed(actor, "actAsCourseStaff", r.institution_id, await courseRoleOf(db, r.course_id, actor.userId))) {
      throw new ForbiddenError();
    }
    const body = z
      .object({
        outcome: z.enum(["accepted", "declined"]),
        response: z.string().trim().min(5, "Tell the student what you decided and why.").max(2000),
      })
      .parse(req.body);
    const updated = await withActor(db, actor.userId, (tx) =>
      tx
        .updateTable("regrade_requests")
        .set({ status: body.outcome, response: body.response, resolved_by: actor.userId, resolved_at: new Date() })
        .where("id", "=", r.id)
        .where("status", "=", "open")
        .returning(["id", "status", "resolved_at"])
        .executeTakeFirst(),
    );
    if (!updated) throw conflict("not_open", "This request has already been answered or withdrawn.");

    const links = await submissionLinks(db, r.submission_id);
    await notify(
      db,
      {
        institutionId: r.institution_id,
        userId: r.user_id,
        type: "regrade_answered",
        title: `Your regrade request for ${links?.title ?? "your assignment"} was ${body.outcome}`,
        body: body.response,
        link: links?.assignment ?? null,
        dedupeKey: `regrade:${r.id}:answered`,
      },
      deps.queue,
    );
    return { request: updated };
  });

  /** The student withdraws their open request. */
  app.post<{ Params: { requestId: string } }>("/v1/regrade-requests/:requestId/withdraw", async (req) => {
    const actor = await authenticate(req, db, verifier);
    const r = await loadRequest(db, req.params.requestId);
    if (r.requested_by !== actor.userId) throw new ForbiddenError();
    const updated = await withActor(db, actor.userId, (tx) =>
      tx
        .updateTable("regrade_requests")
        .set({ status: "withdrawn", resolved_at: new Date() })
        .where("id", "=", r.id)
        .where("status", "=", "open")
        .returning(["id", "status", "resolved_at"])
        .executeTakeFirst(),
    );
    if (!updated) throw conflict("not_open", "This request has already been answered or withdrawn.");
    return { request: updated };
  });
}
