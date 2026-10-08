import { pingDb } from "@hbe/db";
import type { FastifyInstance } from "fastify";
import type { AppDeps } from "../app.ts";

export async function healthRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  // Liveness: the process is up. Used by Render/EC2 health checks and the keep-awake job.
  app.get("/healthz", async () => ({ status: "ok", roles: [...deps.settings.roles] }));

  // Readiness: dependencies are reachable.
  app.get("/readyz", async (_req, reply) => {
    if (!deps.db) return { status: "ok" };
    try {
      await pingDb(deps.db);
      return { status: "ok" };
    } catch {
      return reply.code(503).send({ status: "unavailable", dependency: "database" });
    }
  });
}
