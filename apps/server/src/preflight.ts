import { createDb, sql } from "@hbe/db";
import { describeSettings, loadSettings, type Settings } from "@hbe/settings";
import { createClient } from "@supabase/supabase-js";
import { s3ArchiveStore } from "./archive.ts";
import { createGitHubClient } from "./github.ts";
import { toolKeys } from "./lti/keys.ts";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const BUCKETS = ["grade-reports", "submission-archive", "run-artifacts", "record-exports"];

async function check(name: string, fn: () => Promise<string>): Promise<Check> {
  try {
    return { name, ok: true, detail: await fn() };
  } catch (err) {
    return { name, ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Checks a deployment's configuration before it goes live: `--check-config` validates the
 * environment (as startup would), and `--connect` also reaches every service it names. Nothing
 * is written anywhere.
 *
 *   docker run --rm --env-file demo.env <image> node dist/main.js --check-config --connect
 */
export async function preflight({ connect }: { connect: boolean }): Promise<{ ok: boolean; checks: Check[] }> {
  let settings: Settings;
  try {
    settings = loadSettings();
  } catch (err) {
    return {
      ok: false,
      checks: [{ name: "settings", ok: false, detail: err instanceof Error ? err.message : String(err) }],
    };
  }
  const checks: Check[] = [{ name: "settings", ok: true, detail: JSON.stringify(describeSettings(settings)) }];
  if (settings.roles.has("api")) {
    checks.push(
      await check("lti keys", async () => {
        const keys = await toolKeys(settings);
        if (!keys) return "not set: LMS connections can't use grade passback until LTI_PRIVATE_KEY_BASE64 is set";
        return `signing with ${keys.current.kid}${keys.previous ? `, still publishing ${keys.previous.kid}` : ""}`;
      }),
    );
  }
  if (!connect) return { ok: checks.every((c) => c.ok), checks };
  const { env, roles } = settings;

  if (roles.has("api") || roles.has("worker")) {
    for (const [name, url] of [
      ["database", env.DATABASE_URL],
      ["queue database", env.QUEUE_DATABASE_URL],
    ] as const) {
      checks.push(
        await check(name, async () => {
          const db = createDb({ connectionString: url!, max: 1 });
          try {
            const { rows } = await sql<{ version: string; migrations: number }>`
              select current_setting('server_version') as version,
                     (select count(*)::int from supabase_migrations.schema_migrations) as migrations`.execute(db);
            return `Postgres ${rows[0]!.version}, ${rows[0]!.migrations} migrations applied`;
          } finally {
            await db.destroy();
          }
        }),
      );
    }
  }

  checks.push(
    await check("supabase auth", async () => {
      const res = await fetch(`${env.SUPABASE_URL}/auth/v1/health`, {
        headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return "reachable";
    }),
  );
  if (env.SUPABASE_SECRET_KEY) {
    checks.push(
      await check("storage buckets", async () => {
        const client = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY!, {
          auth: { persistSession: false, autoRefreshToken: false },
        });
        const missing: string[] = [];
        for (const bucket of BUCKETS) {
          const { data } = await client.storage.getBucket(bucket);
          if (!data || data.public) missing.push(bucket);
        }
        if (missing.length) throw new Error(`missing or public: ${missing.join(", ")} (run the migrations)`);
        return BUCKETS.join(", ");
      }),
    );
  }

  const archive = s3ArchiveStore(settings);
  if (archive) {
    checks.push(
      await check("archive bucket", async () => {
        await archive.probe();
        return archive.description;
      }),
    );
  }

  if (roles.has("worker") && env.GRADER_REPO && !env.GITHUB_FAKE) {
    checks.push(
      await check("github app → grader repo", async () => {
        const [owner, repo] = env.GRADER_REPO!.split("/");
        const id = await createGitHubClient(settings).installationIdForRepo(owner!, repo!);
        return `${env.GRADER_REPO} (installation ${id})`;
      }),
    );
  }
  return { ok: checks.every((c) => c.ok), checks };
}
