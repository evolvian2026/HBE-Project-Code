import { authorize, institutionLimits, SLUG_PATTERN, slugify } from "@hbe/core";
import { sql, withActor } from "@hbe/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiDeps } from "../app.ts";
import { authenticate } from "../auth.ts";
import { conflict, notFound } from "../errors.ts";
import { platformHealth } from "../usage.ts";

const createInstitutionBody = z.object({
  name: z.string().trim().min(2).max(200),
  slug: z.string().trim().regex(SLUG_PATTERN, "lowercase letters, digits and hyphens").optional(),
  adminEmail: z.string().trim().email().optional(),
});

const mapInstallationBody = z.object({ institutionId: z.string().uuid().nullable() });

/** Super admin console endpoints (platform level, no tenant data). */
export async function platformRoutes(app: FastifyInstance, { db, verifier, settings }: ApiDeps): Promise<void> {
  /**
   * The platform operator's limits for an institution. Each only tightens the deployment's plan;
   * null removes it (the plan's value applies).
   */
  app.put<{ Params: { institutionId: string } }>("/v1/platform/institutions/:institutionId/limits", async (req) => {
    const actor = await authenticate(req, db, verifier);
    authorize(actor, "listAllInstitutions");
    const institutionId = z.string().uuid().parse(req.params.institutionId);
    const plan = settings.profile.evaluation;
    const body = z
      .object({
        maxActiveStudents: z.number().int().min(1).max(100_000).nullable(),
        institutionConcurrency: z
          .number()
          .int()
          .min(1)
          .max(plan.institution_concurrency, `At most ${plan.institution_concurrency} (the plan's limit)`)
          .nullable(),
        monthlyRunnerMinutes: z
          .number()
          .int()
          .min(1)
          .max(plan.monthly_runner_minutes_budget, `At most ${plan.monthly_runner_minutes_budget} (the plan's budget)`)
          .nullable(),
      })
      .strict()
      .parse(req.body);
    const limits = institutionLimits({
      max_active_students: body.maxActiveStudents ?? undefined,
      institution_concurrency: body.institutionConcurrency ?? undefined,
      monthly_runner_minutes: body.monthlyRunnerMinutes ?? undefined,
    });
    const updated = await withActor(db, actor.userId, (tx) =>
      tx
        .updateTable("institutions")
        .set({ limits: JSON.stringify(limits) })
        .where("id", "=", institutionId)
        .returning("id")
        .executeTakeFirst(),
    );
    if (!updated) throw notFound("Institution not found");
    return { limits };
  });

  /** Queues, failed jobs, webhook backlog, runs and each institution's usage (super admins). */
  app.get("/v1/platform/health", async (req) => {
    const actor = await authenticate(req, db, verifier);
    authorize(actor, "listAllInstitutions");
    return platformHealth(db, settings);
  });

  app.get("/v1/platform/institutions", async (req) => {
    const actor = await authenticate(req, db, verifier);
    authorize(actor, "listAllInstitutions");
    const rows = await db
      .selectFrom("institutions as i")
      .leftJoin("institution_memberships as m", (j) =>
        j.onRef("m.institution_id", "=", "i.id").on("m.status", "=", "active"),
      )
      .select([
        "i.id",
        "i.name",
        "i.slug",
        "i.status",
        "i.created_at",
        "i.contract_ended_at",
        "i.purge_after",
        "i.limits",
        sql<number>`count(m.id) filter (where m.role = 'student')::int`.as("student_count"),
        sql<number>`count(m.id)::int`.as("member_count"),
        sql<number>`count(m.id) filter (where m.role = 'admin')::int`.as("admin_count"),
      ])
      .groupBy("i.id")
      .orderBy("i.name")
      .execute();
    const plan = settings.profile.evaluation;
    return {
      institutions: rows.map((r) => ({ ...r, limits: institutionLimits(r.limits) })),
      plan: {
        institutionConcurrency: plan.institution_concurrency,
        monthlyRunnerMinutes: plan.monthly_runner_minutes_budget,
      },
    };
  });

  app.post("/v1/platform/institutions", async (req, reply) => {
    const actor = await authenticate(req, db, verifier);
    authorize(actor, "createInstitution");
    const body = createInstitutionBody.parse(req.body);
    const slug = body.slug ?? slugify(body.name);
    if (!SLUG_PATTERN.test(slug)) throw conflict("invalid_slug", "Could not derive a valid slug; provide one");

    const taken = await db.selectFrom("institutions").select("id").where("slug", "=", slug).executeTakeFirst();
    if (taken) throw conflict("slug_taken", `The slug "${slug}" is already in use`);

    const result = await withActor(db, actor.userId, async (tx) => {
      const institution = await tx
        .insertInto("institutions")
        .values({ name: body.name, slug, created_by: actor.userId })
        .returning(["id", "name", "slug", "status", "created_at"])
        .executeTakeFirstOrThrow();
      const invitation = body.adminEmail
        ? await tx
            .insertInto("invitations")
            .values({
              institution_id: institution.id,
              email: body.adminEmail.toLowerCase(),
              role: "admin",
              invited_by: actor.userId,
            })
            .returning(["id", "email", "role", "expires_at"])
            .executeTakeFirstOrThrow()
        : null;
      return { institution, invitation };
    });
    return reply.code(201).send(result);
  });

  app.get("/v1/platform/github-installations", async (req) => {
    const actor = await authenticate(req, db, verifier);
    authorize(actor, "mapGithubInstallationManually");
    const rows = await db
      .selectFrom("github_installations as g")
      .leftJoin("institutions as i", "i.id", "g.institution_id")
      .select([
        "g.installation_id",
        "g.account_login",
        "g.account_type",
        "g.suspended_at",
        "g.deleted_at",
        "g.linked_at",
        "i.id as institution_id",
        "i.slug as institution_slug",
      ])
      .orderBy("g.created_at", "desc")
      .execute();
    return { installations: rows };
  });

  app.put<{ Params: { installationId: string } }>("/v1/platform/github-installations/:installationId", async (req) => {
    const actor = await authenticate(req, db, verifier);
    authorize(actor, "mapGithubInstallationManually");
    const installationId = z.coerce.number().int().positive().parse(req.params.installationId);
    const { institutionId } = mapInstallationBody.parse(req.body);

    if (institutionId) {
      const exists = await db
        .selectFrom("institutions")
        .select("id")
        .where("id", "=", institutionId)
        .executeTakeFirst();
      if (!exists) throw notFound("Institution not found");
    }
    const updated = await withActor(db, actor.userId, (tx) =>
      tx
        .updateTable("github_installations")
        .set({
          institution_id: institutionId,
          linked_at: institutionId ? new Date() : null,
          linked_by: institutionId ? actor.userId : null,
        })
        .where("installation_id", "=", installationId)
        .returning(["installation_id", "institution_id"])
        .executeTakeFirst(),
    );
    if (!updated) throw notFound("Installation not found");
    if (institutionId) {
      await db
        .updateTable("github_events")
        .set({ institution_id: institutionId })
        .where("installation_id", "=", installationId)
        .where("institution_id", "is", null)
        .execute();
    }
    return updated;
  });
}
