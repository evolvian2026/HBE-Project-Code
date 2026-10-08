import { authorize } from "@hbe/core";
import { withActor } from "@hbe/db";
import { installAppUrl } from "@hbe/github";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiDeps } from "../app.ts";
import { authenticate } from "../auth.ts";
import { conflict } from "../errors.ts";

const LINK_REQUEST_TTL_MINUTES = 60;

/** Institution admin endpoints. */
export async function institutionRoutes(app: FastifyInstance, { db, verifier, settings }: ApiDeps): Promise<void> {
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
