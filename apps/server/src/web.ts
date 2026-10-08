import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/**
 * Serves the built Next.js app (apps/web) from this process when ROLES includes web.
 * API routes are registered first and win; everything else is handed to Next.
 */
export async function mountWeb(app: FastifyInstance, dir: string | undefined): Promise<void> {
  const { default: next } = await import("next");
  // dist/main.js → apps/server/dist → apps/web (Docker images set WEB_DIR explicitly)
  const webDir = dir ?? fileURLToPath(new URL("../../web", import.meta.url));
  const nextApp = next({ dev: false, dir: webDir });
  await nextApp.prepare();
  const handle = nextApp.getRequestHandler();

  await app.register(async (scope) => {
    // Leave request bodies unread: Next parses its own (server actions, route handlers).
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", (_req, _payload, done) => done(null));

    const forward = async (req: FastifyRequest, reply: FastifyReply) => {
      reply.hijack();
      await handle(req.raw, reply.raw);
    };
    // Not OPTIONS: CORS preflight for the API already owns `OPTIONS /*`.
    const method = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];
    scope.route({ method, url: "/", logLevel: "warn", handler: forward });
    scope.route({ method, url: "/*", logLevel: "warn", handler: forward });
  });
}
