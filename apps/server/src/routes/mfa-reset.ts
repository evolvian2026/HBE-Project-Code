import { authorize, ForbiddenError } from "@hbe/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiDeps } from "../app.ts";
import { authenticate } from "../auth.ts";
import { notFound } from "../errors.ts";
import type { MfaAdmin } from "../mfa-admin.ts";
import { notify } from "../notifications.ts";

/**
 * An institution's admins reset a member's two-factor authentication (a lost phone): the person
 * sets it up again at their next sign-in if they need it. Only for people who belong to no other
 * institution and aren't super admins (anyone else: the platform operator), always audited, and
 * the person is told by email.
 */
export async function mfaResetRoutes(app: FastifyInstance, deps: ApiDeps & { mfaAdmin: MfaAdmin }): Promise<void> {
  const { db, verifier, queue, mfaAdmin } = deps;

  app.post<{ Params: { institutionId: string; userId: string } }>(
    "/v1/institutions/:institutionId/members/:userId/reset-mfa",
    async (req) => {
      const actor = await authenticate(req, db, verifier);
      const institutionId = z.string().uuid().parse(req.params.institutionId);
      const userId = z.string().uuid().parse(req.params.userId);
      if (!actor.isSuperAdmin) authorize(actor, "manageInstitution", institutionId);
      if (userId === actor.userId)
        throw new ForbiddenError("Reset your own two-factor authentication from your account page.");
      const member = await db
        .selectFrom("institution_memberships")
        .select("id")
        .where("institution_id", "=", institutionId)
        .where("user_id", "=", userId)
        .executeTakeFirst();
      if (!member) throw notFound("Not a member of this institution");
      if (!actor.isSuperAdmin) {
        const elsewhere = await db
          .selectFrom("institution_memberships")
          .select("id")
          .where("user_id", "=", userId)
          .where("institution_id", "!=", institutionId)
          .executeTakeFirst();
        const platformRole = await db
          .selectFrom("user_roles")
          .select("role")
          .where("user_id", "=", userId)
          .executeTakeFirst();
        if (elsewhere || platformRole) {
          throw new ForbiddenError(
            "This person belongs elsewhere on the platform too: ask the platform operator to reset it.",
          );
        }
      }
      const removed = await mfaAdmin.removeFactors(userId);
      await db
        .insertInto("audit_logs")
        .values({
          institution_id: institutionId,
          actor_id: actor.userId,
          action: "delete",
          entity: "mfa_factors",
          entity_id: userId,
          before: JSON.stringify({ factors: removed }),
          after: null,
        })
        .execute();
      await notify(
        db,
        {
          institutionId,
          userId,
          type: "account_security",
          title: "Your two-factor authentication was reset by an administrator",
          body: "If you didn't ask for this, tell your institution's administrators at once. Set it up again from your account page.",
          link: "/account/security",
          dedupeKey: `mfa-reset:${userId}:${Date.now()}`,
        },
        queue,
      );
      req.log.warn({ institutionId, userId, removed }, "two-factor authentication reset by an admin");
      return { removed };
    },
  );
}
