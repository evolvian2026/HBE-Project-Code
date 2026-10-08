import { createDb } from "@hbe/db";
import { PgBossQueue } from "@hbe/queue";
import { describeSettings, loadSettings } from "@hbe/settings";
import { buildApp, loggerOptions } from "./app.ts";
import { supabaseTokenVerifier } from "./auth.ts";
import { createGitHubClient } from "./github.ts";
import { startWorker } from "./worker/index.ts";

/**
 * One entry point for every role (ROLES=web,api,worker). On the free tier all three run
 * in this process; on EC2 each container runs one. See docs/DEPLOYMENT.md.
 */
async function start(): Promise<void> {
  const settings = loadSettings();
  const { env, profile, roles } = settings;
  const serverSide = roles.has("api") || roles.has("worker");

  // Settings validation guarantees these URLs exist whenever api or worker is enabled.
  const db = serverSide
    ? createDb({
        connectionString: env.DATABASE_URL!,
        max: profile.database.app_pool_max,
        applicationName: `hbe-${[...roles].join("-")}`,
      })
    : null;

  const queue = serverSide
    ? new PgBossQueue({
        connectionString: env.QUEUE_DATABASE_URL!,
        max: profile.database.queue_pool_max,
        timezone: env.TZ,
        archiveDays: profile.retention.queue_archive_days,
        runsMaintenance: roles.has("worker"),
      })
    : null;

  const app = await buildApp(
    { settings, db, queue, verifier: supabaseTokenVerifier(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY) },
    loggerOptions(env.LOG_LEVEL),
  );
  app.log.info(describeSettings(settings), "configuration loaded");

  await queue?.start();
  if (roles.has("worker") && db && queue) {
    await startWorker(
      { db, queue, settings, github: createGitHubClient(settings), log: app.log.child({ role: "worker" }) },
      settings,
    );
  }
  if (roles.has("web")) {
    const { mountWeb } = await import("./web.ts");
    await mountWeb(app, env.WEB_DIR);
  }

  await app.listen({ port: env.PORT, host: "0.0.0.0" });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    app.log.info({ signal }, "shutting down");
    const force = setTimeout(() => process.exit(1), 30_000);
    force.unref();
    try {
      await app.close();
      await queue?.stop();
      await db?.destroy();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

start().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
