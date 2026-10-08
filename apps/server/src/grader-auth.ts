import { timingSafeEqual } from "node:crypto";
import type { Settings } from "@hbe/settings";
import type { FastifyRequest } from "fastify";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { hashToken } from "./evaluation.ts";
import { HttpError } from "./errors.ts";

export interface GraderIdentity {
  /** GitHub Actions workflow run id (OIDC), used to bind later callbacks to the same job. */
  workflowRunId: number | null;
}

export interface RunCredentials {
  callback_token_hash: string | null;
  gh_workflow_run_id: number | null;
}

/** Authenticates the grader's callbacks for a specific evaluation run. */
export interface GraderAuth {
  verify(req: FastifyRequest, run: RunCredentials): Promise<GraderIdentity>;
}

const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const forbidden = (message: string) => new HttpError(401, "invalid_grader_token", message);

function bearer(req: FastifyRequest): string {
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) throw forbidden("Missing grader token");
  return h.slice("Bearer ".length).trim();
}

/**
 * Production: a GitHub Actions OIDC token minted for the grader repository's workflow on
 * the configured branch, with this API as audience. There are no shared secrets. The first
 * callback binds the run to that workflow run; later callbacks must come from the same one.
 */
export function oidcGraderAuth(
  settings: Settings,
  jwks: JWTVerifyGetKey = createRemoteJWKSet(new URL(`${GITHUB_OIDC_ISSUER}/.well-known/jwks`)),
): GraderAuth {
  const repository = settings.env.GRADER_REPO;
  const workflowRef = `${repository}/.github/workflows/${settings.env.GRADER_WORKFLOW}@refs/heads/${settings.env.GRADER_REF}`;
  return {
    async verify(req, run) {
      let payload;
      try {
        ({ payload } = await jwtVerify(bearer(req), jwks, {
          issuer: GITHUB_OIDC_ISSUER,
          audience: settings.env.API_URL,
        }));
      } catch {
        throw forbidden("Invalid grader token");
      }
      if (payload.repository !== repository || payload.workflow_ref !== workflowRef) {
        throw forbidden("Token is not from the grader workflow");
      }
      const workflowRunId = Number(payload.run_id);
      if (!Number.isSafeInteger(workflowRunId)) throw forbidden("Token has no run id");
      if (run.gh_workflow_run_id !== null && run.gh_workflow_run_id !== workflowRunId) {
        throw forbidden("This evaluation run belongs to another grader job");
      }
      return { workflowRunId };
    },
  };
}

/** Local development only (settings refuse it elsewhere): a per-run random token. */
export function tokenGraderAuth(): GraderAuth {
  return {
    async verify(req, run) {
      const given = Buffer.from(hashToken(bearer(req)));
      const expected = Buffer.from(run.callback_token_hash ?? "");
      if (given.length !== expected.length || !timingSafeEqual(given, expected))
        throw forbidden("Invalid grader token");
      return { workflowRunId: null };
    },
  };
}

export function createGraderAuth(settings: Settings): GraderAuth {
  return settings.env.GRADER_CALLBACK_AUTH === "token" ? tokenGraderAuth() : oidcGraderAuth(settings);
}
