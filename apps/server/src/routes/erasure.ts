import { authorize, ForbiddenError } from "@hbe/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiDeps } from "../app.ts";
import { authenticate } from "../auth.ts";
import { erasureBlocker } from "../erasure.ts";
import { HttpError, notFound } from "../errors.ts";
import { notify } from "../notifications.ts";

const note = z.string().trim().max(2000).optional();

/**
 * Erasure requests (FR-9.6). A person asks for their data in an institution to be erased, or an
 * admin starts it; an admin (never the person themselves) decides how: anonymise or delete.
 * The worker carries it out (erasure.ts).
 */
export async function erasureRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const { db, verifier, queue } = deps;

  const start = async (requestId: string) => {
    await queue.send("erase-person", { requestId }, { singletonKey: `erase-${requestId}` });
  };
  const openRequest = (institutionId: string, subjectId: string) =>
    db
      .selectFrom("erasure_requests")
      .select("id")
      .where("institution_id", "=", institutionId)
      .where("subject_id", "=", subjectId)
      .where("status", "in", ["requested", "approved", "running", "failed"])
      .executeTakeFirst();

  // An admin erases a member's data.
  app.post<{ Params: { institutionId: string } }>(
    "/v1/institutions/:institutionId/erasure-requests",
    async (req, reply) => {
      const actor = await authenticate(req, db, verifier);
      const institutionId = z.string().uuid().parse(req.params.institutionId);
      const body = z.object({ userId: z.string().uuid(), mode: z.enum(["anonymise", "delete"]), note }).parse(req.body);
      if (!actor.isSuperAdmin) authorize(actor, "manageInstitution", institutionId);
      if (body.userId === actor.userId) {
        throw new ForbiddenError("Ask for your own data to be erased from your account page: another admin decides.");
      }
      const member = await db
        .selectFrom("institution_memberships")
        .select("role")
        .where("institution_id", "=", institutionId)
        .where("user_id", "=", body.userId)
        .executeTakeFirst();
      if (!member) throw notFound("Not a member of this institution");
      const blocker = await erasureBlocker(db, institutionId, body.userId);
      if (blocker) throw new HttpError(409, "not_erasable", blocker);
      if (await openRequest(institutionId, body.userId)) {
        throw new HttpError(409, "already_requested", "There's already an erasure request for this person.");
      }
      const created = await db
        .insertInto("erasure_requests")
        .values({
          institution_id: institutionId,
          subject_id: body.userId,
          subject_role: member.role,
          requested_via: "admin",
          requested_by: actor.userId,
          note: body.note || null,
          status: "approved",
          mode: body.mode,
          decided_by: actor.userId,
          decided_at: new Date(),
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await start(created.id);
      return reply.code(201).send({ id: created.id });
    },
  );

  // A person asks for their own data in an institution to be erased.
  app.post("/v1/me/erasure-requests", async (req, reply) => {
    const actor = await authenticate(req, db, verifier);
    const body = z.object({ institutionId: z.string().uuid(), note }).parse(req.body);
    const member = await db
      .selectFrom("institution_memberships as m")
      .innerJoin("institutions as i", "i.id", "m.institution_id")
      .select(["m.role", "i.name", "i.slug"])
      .where("m.institution_id", "=", body.institutionId)
      .where("m.user_id", "=", actor.userId)
      .where("m.status", "=", "active")
      .executeTakeFirst();
    if (!member) throw notFound("You're not a member of this institution");
    if (await openRequest(body.institutionId, actor.userId)) {
      throw new HttpError(409, "already_requested", "You've already asked; an admin will decide.");
    }
    const created = await db
      .insertInto("erasure_requests")
      .values({
        institution_id: body.institutionId,
        subject_id: actor.userId,
        subject_role: member.role,
        requested_via: "self",
        requested_by: actor.userId,
        note: body.note || null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const admins = await db
      .selectFrom("institution_memberships")
      .select("user_id")
      .where("institution_id", "=", body.institutionId)
      .where("role", "=", "admin")
      .where("status", "=", "active")
      .where("user_id", "<>", actor.userId)
      .execute();
    for (const a of admins) {
      await notify(
        db,
        {
          institutionId: body.institutionId,
          userId: a.user_id,
          type: "erasure_request",
          title: "Someone asked for their personal data to be erased",
          body: "Decide on the Members page: anonymise their records, delete them, or decline.",
          link: `/i/${member.slug}/members#erasure`,
          dedupeKey: `erasure-asked:${created.id}`,
        },
        queue,
      );
    }
    return reply.code(201).send({ id: created.id });
  });

  // An admin decides on a request (or retries one that failed).
  app.post<{ Params: { requestId: string } }>("/v1/erasure-requests/:requestId/decision", async (req) => {
    const actor = await authenticate(req, db, verifier);
    const requestId = z.string().uuid().parse(req.params.requestId);
    const body = z.object({ decision: z.enum(["anonymise", "delete", "reject"]), note }).parse(req.body);
    const r = await db.selectFrom("erasure_requests").selectAll().where("id", "=", requestId).executeTakeFirst();
    if (!r) throw notFound("Request not found");
    if (!actor.isSuperAdmin) authorize(actor, "manageInstitution", r.institution_id);
    if (r.subject_id === actor.userId) throw new ForbiddenError("Another admin decides on your own request.");
    if (!["requested", "failed"].includes(r.status)) {
      throw new HttpError(409, "decided", "This request has already been decided.");
    }
    if (r.status === "failed" && (body.decision === "reject" || body.decision !== r.mode) && r.pseudonym_id) {
      // Half done: it can only be finished the way it was started.
      throw new HttpError(409, "in_progress", `This erasure is under way: retry it as "${r.mode}".`);
    }
    if (body.decision === "reject") {
      await db
        .updateTable("erasure_requests")
        .set({ status: "rejected", decided_by: actor.userId, decided_at: new Date(), decision_note: body.note || null })
        .where("id", "=", requestId)
        .execute();
      if (r.subject_id) {
        const inst = await db
          .selectFrom("institutions")
          .select("slug")
          .where("id", "=", r.institution_id)
          .executeTakeFirstOrThrow();
        await notify(
          db,
          {
            institutionId: r.institution_id,
            userId: r.subject_id,
            type: "erasure_request",
            title: "Your request to erase your data was declined",
            body: body.note || "Ask your institution's admins why.",
            link: `/i/${inst.slug}`,
            dedupeKey: `erasure-declined:${requestId}`,
          },
          queue,
        );
      }
      return { status: "rejected" };
    }
    if (r.subject_id) {
      const blocker = await erasureBlocker(db, r.institution_id, r.subject_id);
      if (blocker) throw new HttpError(409, "not_erasable", blocker);
    }
    await db
      .updateTable("erasure_requests")
      .set({
        status: "approved",
        mode: body.decision,
        error: null,
        decided_by: actor.userId,
        decided_at: new Date(),
        decision_note: body.note || null,
      })
      .where("id", "=", requestId)
      .execute();
    await start(requestId);
    return { status: "approved" };
  });
}
