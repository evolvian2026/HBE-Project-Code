import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "../app.ts";
import { authenticate } from "../auth.ts";

export async function meRoutes(app: FastifyInstance, { db, verifier }: ApiDeps): Promise<void> {
  app.get("/v1/me", async (req) => {
    const actor = await authenticate(req, db, verifier);
    const [profile, memberships] = await Promise.all([
      db
        .selectFrom("profiles")
        .select(["id", "email", "full_name", "avatar_url", "github_user_id", "github_login"])
        .where("id", "=", actor.userId)
        .executeTakeFirstOrThrow(),
      db
        .selectFrom("institution_memberships as m")
        .innerJoin("institutions as i", "i.id", "m.institution_id")
        .select(["i.id", "i.name", "i.slug", "i.status", "m.role"])
        .where("m.user_id", "=", actor.userId)
        .where("m.status", "=", "active")
        .where("i.status", "in", ["active", "read_only"])
        .orderBy("i.name")
        .execute(),
    ]);
    return {
      profile,
      isSuperAdmin: actor.isSuperAdmin,
      mfaSatisfied: actor.mfaSatisfied,
      institutions: memberships.map(({ role, ...institution }) => ({ ...institution, role })),
    };
  });
}
