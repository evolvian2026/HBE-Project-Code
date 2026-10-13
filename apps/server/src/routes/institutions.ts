import { authorize, ForbiddenError, institutionSettings, roleIn } from "@hbe/core";
import { withActor } from "@hbe/db";
import { installAppUrl } from "@hbe/github";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiDeps } from "../app.ts";
import { authenticate } from "../auth.ts";
import { conflict, notFound } from "../errors.ts";
import { institutionUsage } from "../usage.ts";

const LINK_REQUEST_TTL_MINUTES = 60;

const int = (min: number, max: number) => z.number().int().min(min).max(max);
/** What new assignments start with (validated strictly; stored values are read leniently). */
const assignmentDefaults = z
  .object({
    run_quota_per_day: int(0, 100),
    weights: z
      .object({ automated: int(0, 100), rubric: int(0, 100), process: int(0, 100) })
      .strict()
      .refine((w) => w.automated + w.rubric + w.process === 100, "Grade weights must add up to 100"),
    late_policy: z.object({ per_day_percent: int(0, 100), max_days: int(0, 60), grace_minutes: int(0, 1440) }).strict(),
    regrade_window_days: int(0, 60),
    triggers: z.object({ on_push: z.boolean(), on_pull_request: z.boolean(), manual: z.boolean() }).strict(),
    post_feedback_to_github: z.boolean(),
  })
  .strict();

/** Institution admin endpoints. */
export async function institutionRoutes(app: FastifyInstance, { db, verifier, settings }: ApiDeps): Promise<void> {
  /** What the institution used this month, against its limits (its admins). */
  app.get<{ Params: { institutionId: string } }>("/v1/institutions/:institutionId/usage", async (req) => {
    const actor = await authenticate(req, db, verifier);
    const institutionId = z.string().uuid().parse(req.params.institutionId);
    // Read-only institutions' admins may look too.
    if (!actor.isSuperAdmin && roleIn(actor, institutionId) !== "admin") throw new ForbiddenError();
    return institutionUsage(db, settings, institutionId);
  });

  /** The institution's admins rename it and choose what new assignments start with. */
  app.put<{ Params: { institutionId: string } }>("/v1/institutions/:institutionId/settings", async (req) => {
    const actor = await authenticate(req, db, verifier);
    const institutionId = z.string().uuid().parse(req.params.institutionId);
    authorize(actor, "manageInstitution", institutionId);
    const body = z
      .object({ name: z.string().trim().min(2).max(200).optional(), assignmentDefaults: assignmentDefaults.optional() })
      .strict()
      .parse(req.body);
    const inst = await db
      .selectFrom("institutions")
      .select(["settings"])
      .where("id", "=", institutionId)
      .executeTakeFirst();
    if (!inst) throw notFound("Institution not found");
    const next = {
      ...institutionSettings(inst.settings),
      ...(body.assignmentDefaults ? { assignment_defaults: body.assignmentDefaults } : {}),
    };
    await withActor(db, actor.userId, (tx) =>
      tx
        .updateTable("institutions")
        .set({ settings: JSON.stringify(next), ...(body.name ? { name: body.name } : {}) })
        .where("id", "=", institutionId)
        .execute(),
    );
    return { settings: next };
  });

  /**
   * Starts linking a GitHub organisation. The installation is mapped when GitHub's
   * signed `installation.created` webhook arrives with this admin as its sender
   * (see supabase/migrations/*_github.sql), so the redirect can't be forged.
   */
  app.post<{ Params: { institutionId: string } }>(
    "/v1/institutions/:institutionId/github/link-requests",
    async (req, reply) => {
      const actor = await authenticate(req, db, verifier);
      const institutionId = z.string().uuid().parse(req.params.institutionId);
      authorize(actor, "linkGithubInstallation", institutionId);
      if (!actor.githubUserId) {
        throw conflict(
          "github_not_linked",
          "Link your GitHub account to your profile before connecting an organisation",
        );
      }
      const appSlug = settings.env.GITHUB_APP_SLUG;
      if (!appSlug) throw new Error("GITHUB_APP_SLUG is not configured");

      const request = await withActor(db, actor.userId, (tx) =>
        tx
          .insertInto("github_link_requests")
          .values({
            institution_id: institutionId,
            requested_by: actor.userId,
            github_user_id: actor.githubUserId!,
            expires_at: new Date(Date.now() + LINK_REQUEST_TTL_MINUTES * 60_000),
          })
          .returning(["id", "expires_at"])
          .executeTakeFirstOrThrow(),
      );
      return reply.code(201).send({ ...request, installUrl: installAppUrl(appSlug) });
    },
  );

  /**
   * GitHub's post-install redirect ("Setup URL"). Its parameters are untrusted, so it
   * only forwards the user to the app; the webhook does the linking.
   */
  app.get<{ Querystring: { installation_id?: string; setup_action?: string } }>(
    "/v1/github/setup",
    async (req, reply) => {
      const target = new URL("/github/installed", settings.env.APP_URL);
      const installationId = Number(req.query.installation_id);
      if (Number.isSafeInteger(installationId) && installationId > 0) {
        target.searchParams.set("installation_id", String(installationId));
      }
      if (req.query.setup_action === "install" || req.query.setup_action === "update") {
        target.searchParams.set("setup_action", req.query.setup_action);
      }
      return reply.redirect(target.toString(), 302);
    },
  );
}
