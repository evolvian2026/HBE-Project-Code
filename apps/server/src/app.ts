import cors from "@fastify/cors";
import { ForbiddenError } from "@hbe/core";
import type { Db } from "@hbe/db";
import type { JobQueue } from "@hbe/queue";
import type { GitHubClient } from "@hbe/github";
import type { Settings } from "@hbe/settings";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { ZodError } from "zod";
import type { TokenVerifier } from "./auth.ts";
import { HttpError } from "./errors.ts";
import { createGraderAuth, type GraderAuth } from "./grader-auth.ts";
import { createGitHubClient, lazyGitHubClient } from "./github.ts";
import { s3ArchiveStore, type ArchiveStore } from "./archive.ts";
import { supabaseSignIn, type SignInService } from "./lti/sign-in.ts";
import { supabaseObjectStore, type ObjectStore } from "./storage.ts";
import { recordsRoutes } from "./routes/records.ts";
import { assignmentRoutes } from "./routes/assignments.ts";
import { codeRoutes } from "./routes/code.ts";
import { gradingRoutes } from "./routes/grading.ts";
import { regradeRoutes } from "./routes/regrades.ts";
import { runRoutes } from "./routes/runs.ts";
import { healthRoutes } from "./routes/health.ts";
import { institutionRoutes } from "./routes/institutions.ts";
import { lmsRoutes } from "./routes/lms.ts";
import { ltiRoutes } from "./routes/lti.ts";
import { meRoutes } from "./routes/me.ts";
import { platformRoutes } from "./routes/platform.ts";
import { webhookRoutes } from "./routes/webhooks.ts";

export interface AppDeps {
  settings: Settings;
  /** Null only for a web-only process. */
  db: Db | null;
  /** Null only for a web-only process. */
  queue: JobQueue | null;
  verifier: TokenVerifier;
  /** Defaults to the configured grader callback authentication. */
  graderAuth?: GraderAuth;
  /** Defaults to Supabase Storage. */
  store?: ObjectStore;
  /** Defaults to the configured archive bucket (none locally). */
  archive?: ArchiveStore | null;
  /** Defaults to the configured GitHub App (or the local fake). */
  github?: GitHubClient;
  /** Defaults to Supabase Auth's admin API (signing people in after an LMS launch). */
  signIn?: SignInService;
}

/** Dependencies of routes that only exist in api processes. */
export interface ApiDeps extends AppDeps {
  db: Db;
  queue: JobQueue;
}

export async function buildApp(
  deps: AppDeps,
  logger: FastifyServerOptions["logger"] = false,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger,
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({ error: error.code, message: error.message, ...error.details });
    }
    if (error instanceof ForbiddenError) {
      return reply.code(403).send({ error: "forbidden", message: error.message });
    }
    if (error instanceof ZodError) {
      const message = error.issues[0]?.message ?? "Invalid request";
      return reply.code(400).send({ error: "invalid_request", message, issues: error.issues });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: "bad_request", message: (error as Error).message });
    }
    req.log.error({ err: error }, "unhandled error");
    return reply.code(500).send({ error: "internal_error", message: "Something went wrong" });
  });

  await app.register(healthRoutes, deps);

  if (deps.settings.roles.has("api")) {
    if (!deps.db || !deps.queue) throw new Error("The api role needs a database and a queue");
    const apiDeps: ApiDeps = { ...deps, db: deps.db, queue: deps.queue };
    await app.register(cors, { origin: [deps.settings.env.APP_URL], credentials: true });
    await app.register(webhookRoutes, apiDeps);
    await app.register(meRoutes, apiDeps);
    await app.register(platformRoutes, apiDeps);
    await app.register(institutionRoutes, apiDeps);
    await app.register(assignmentRoutes, apiDeps);
    await app.register(runRoutes, {
      ...apiDeps,
      graderAuth: deps.graderAuth ?? createGraderAuth(deps.settings),
      store: deps.store ?? supabaseObjectStore(deps.settings),
    });
    await app.register(gradingRoutes, apiDeps);
    await app.register(regradeRoutes, apiDeps);
    await app.register(recordsRoutes, {
      ...apiDeps,
      store: deps.store ?? supabaseObjectStore(deps.settings),
      archive: deps.archive === undefined ? s3ArchiveStore(deps.settings) : deps.archive,
    });
    await app.register(codeRoutes, {
      ...apiDeps,
      github: deps.github ?? lazyGitHubClient(() => createGitHubClient(deps.settings)),
    });
    await app.register(ltiRoutes, { ...apiDeps, signIn: deps.signIn ?? supabaseSignIn(deps.settings) });
    await app.register(lmsRoutes, apiDeps);
  }

  return app;
}

export function loggerOptions(level: string): FastifyServerOptions["logger"] {
  return {
    level,
    redact: {
      paths: ["req.headers.authorization", "req.headers.cookie", 'req.headers["x-hub-signature-256"]'],
      censor: "[redacted]",
    },
  };
}
