import { authorize, ForbiddenError, institutionSettings } from "@hbe/core";
import { withActor } from "@hbe/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiDeps } from "../app.ts";
import { authenticate } from "../auth.ts";
import { conflict, notFound } from "../errors.ts";
import { stackDefinitionSchema } from "../stack-definition.ts";

const uuid = z.string().uuid();
const key = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/, "Key: lowercase letters, digits and hyphens (3–50)");
const status = z.object({ status: z.enum(["active", "retired"]) }).strict();

/**
 * Stack profiles and test suites (§7, institution admin panel). Institution admins add
 * versions of their own stack profiles, retire them, and choose which global ones their
 * teachers may pick; the platform operator registers test suite versions (their code lives
 * in the grader repository). Profiles and suites are immutable once used: a change is a new
 * version, and retired ones stay for the assignments and runs that used them.
 */
export async function stackRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const { db, verifier } = deps;

  app.post<{ Params: { institutionId: string } }>(
    "/v1/institutions/:institutionId/stack-profiles",
    async (req, reply) => {
      const actor = await authenticate(req, db, verifier);
      const institutionId = uuid.parse(req.params.institutionId);
      authorize(actor, "manageInstitution", institutionId);
      const body = z
        .object({
          key,
          displayName: z.string().trim().min(2).max(100),
          description: z.string().trim().max(500).optional(),
          definition: stackDefinitionSchema,
        })
        .strict()
        .parse(req.body);
      const global = await db
        .selectFrom("stack_profiles")
        .select("id")
        .where("institution_id", "is", null)
        .where("key", "=", body.key)
        .executeTakeFirst();
      if (global) throw conflict("key_taken", "A global stack profile uses that key. Choose another.");
      const latest = await db
        .selectFrom("stack_profiles")
        .select((eb) => eb.fn.max("version").as("version"))
        .where("institution_id", "=", institutionId)
        .where("key", "=", body.key)
        .executeTakeFirst();
      const profile = await withActor(db, actor.userId, (tx) =>
        tx
          .insertInto("stack_profiles")
          .values({
            institution_id: institutionId,
            key: body.key,
            version: (latest?.version ?? 0) + 1,
            display_name: body.displayName,
            description: body.description || null,
            definition: JSON.stringify(body.definition),
          })
          .returning(["id", "key", "version"])
          .executeTakeFirstOrThrow(),
      );
      return reply.code(201).send(profile);
    },
  );

  /** Retires (or restores) a stack profile: retired ones can't be picked for new assignments. */
  app.patch<{ Params: { profileId: string } }>("/v1/stack-profiles/:profileId", async (req) => {
    const actor = await authenticate(req, db, verifier);
    const profile = await db
      .selectFrom("stack_profiles")
      .select(["id", "institution_id"])
      .where("id", "=", uuid.parse(req.params.profileId))
      .executeTakeFirst();
    if (!profile) throw notFound("Stack profile not found");
    if (profile.institution_id) authorize(actor, "manageInstitution", profile.institution_id);
    else if (!actor.isSuperAdmin) throw new ForbiddenError();
    const body = status.parse(req.body);
    await withActor(db, actor.userId, (tx) =>
      tx.updateTable("stack_profiles").set({ status: body.status }).where("id", "=", profile.id).execute(),
    );
    return { id: profile.id, status: body.status };
  });

  /** Which global stack profiles the institution's teachers may pick (the others are hidden). */
  app.put<{ Params: { institutionId: string } }>("/v1/institutions/:institutionId/offered-profiles", async (req) => {
    const actor = await authenticate(req, db, verifier);
    const institutionId = uuid.parse(req.params.institutionId);
    authorize(actor, "manageInstitution", institutionId);
    const { hidden } = z
      .object({ hidden: z.array(uuid).max(500) })
      .strict()
      .parse(req.body);
    const globals = new Set(
      (await db.selectFrom("stack_profiles").select("id").where("institution_id", "is", null).execute()).map(
        (p) => p.id,
      ),
    );
    if (hidden.some((id) => !globals.has(id))) throw notFound("Only global stack profiles can be hidden");
    const inst = await db
      .selectFrom("institutions")
      .select("settings")
      .where("id", "=", institutionId)
      .executeTakeFirstOrThrow();
    const next = { ...institutionSettings(inst.settings), hidden_stack_profiles: [...new Set(hidden)] };
    await withActor(db, actor.userId, (tx) =>
      tx
        .updateTable("institutions")
        .set({ settings: JSON.stringify(next) })
        .where("id", "=", institutionId)
        .execute(),
    );
    return { hidden: next.hidden_stack_profiles };
  });

  /** The platform operator registers a version of a test suite, for everyone or one institution. */
  app.post("/v1/platform/grader-suites", async (req, reply) => {
    const actor = await authenticate(req, db, verifier);
    authorize(actor, "listAllInstitutions");
    const body = z
      .object({
        institutionId: uuid.nullable(),
        key,
        title: z.string().trim().min(2).max(200),
        path: z
          .string()
          .trim()
          .regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/, "A folder in the grader repository, e.g. suites/acme/shop")
          .refine((p) => !p.split("/").includes(".."), "A folder in the grader repository"),
        gitRef: z
          .string()
          .trim()
          .regex(/^[A-Za-z0-9._/-]{1,200}$/, "A branch, tag or commit of the grader repository")
          .default("main"),
        stackProfileId: uuid.nullable().default(null),
      })
      .strict()
      .parse(req.body);
    if (body.institutionId) {
      const inst = await db
        .selectFrom("institutions")
        .select("id")
        .where("id", "=", body.institutionId)
        .executeTakeFirst();
      if (!inst) throw notFound("Institution not found");
    }
    if (body.stackProfileId) {
      const profile = await db
        .selectFrom("stack_profiles")
        .select("institution_id")
        .where("id", "=", body.stackProfileId)
        .executeTakeFirst();
      if (!profile || (profile.institution_id && profile.institution_id !== body.institutionId)) {
        throw notFound("Stack profile not found for that institution");
      }
    }
    const latest = await db
      .selectFrom("grader_suites")
      .select((eb) => eb.fn.max("version").as("version"))
      .where((eb) =>
        body.institutionId ? eb("institution_id", "=", body.institutionId) : eb("institution_id", "is", null),
      )
      .where("key", "=", body.key)
      .executeTakeFirst();
    const suite = await withActor(db, actor.userId, (tx) =>
      tx
        .insertInto("grader_suites")
        .values({
          institution_id: body.institutionId,
          key: body.key,
          version: (latest?.version ?? 0) + 1,
          title: body.title,
          path: body.path,
          git_ref: body.gitRef,
          stack_profile_id: body.stackProfileId,
        })
        .returning(["id", "key", "version"])
        .executeTakeFirstOrThrow(),
    );
    return reply.code(201).send(suite);
  });

  /** Retires (or restores) a suite version: retired ones can't be chosen for assignments. */
  app.patch<{ Params: { suiteId: string } }>("/v1/grader-suites/:suiteId", async (req) => {
    const actor = await authenticate(req, db, verifier);
    const suite = await db
      .selectFrom("grader_suites")
      .select(["id", "institution_id"])
      .where("id", "=", uuid.parse(req.params.suiteId))
      .executeTakeFirst();
    if (!suite) throw notFound("Test suite not found");
    if (suite.institution_id) {
      if (!actor.isSuperAdmin) authorize(actor, "manageInstitution", suite.institution_id);
    } else if (!actor.isSuperAdmin) throw new ForbiddenError();
    const body = status.parse(req.body);
    await withActor(db, actor.userId, (tx) =>
      tx.updateTable("grader_suites").set({ status: body.status }).where("id", "=", suite.id).execute(),
    );
    return { id: suite.id, status: body.status };
  });
}
