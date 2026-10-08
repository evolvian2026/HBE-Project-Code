import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const roles = z.enum(["web", "api", "worker"]);

export const profileSchema = z.object({
  profile: z.enum(["free", "paid"]),
  runtime: z.object({
    default_roles: z.array(roles).min(1),
    queue_concurrency: z.number().int().positive(),
    pdf_concurrency: z.number().int().positive(),
  }),
  database: z.object({
    app_pool_max: z.number().int().positive(),
    queue_pool_max: z.number().int().positive(),
  }),
  retention: z.object({
    contract_grace_years: z.number().int().positive(),
    raw_webhook_days: z.number().int().positive(),
    nonfinal_artifact_days: z.number().int().positive(),
    queue_archive_days: z.number().int().positive(),
    playwright_traces: z.enum(["on_failure", "always", "never"]),
    export_notice_days: z.array(z.number().int().positive()),
  }),
  evaluation: z.object({
    runner: z.enum(["github_hosted", "self_hosted"]),
    runs_per_student_per_day: z.number().int().positive(),
    global_concurrency: z.number().int().positive(),
    institution_concurrency: z.number().int().positive(),
    monthly_runner_minutes_budget: z.number().int().positive(),
    push_debounce_seconds: z.number().int().nonnegative(),
    job_timeout_minutes: z.number().int().positive(),
  }),
  backups: z.object({
    strategy: z.enum(["pg_dump_to_archive", "supabase_pitr"]),
    pg_dump_keep_days: z.number().int().positive(),
    archive_replication: z.boolean(),
  }),
  email: z.object({
    daily_cap: z.number().int().positive(),
  }),
  features: z.object({
    saml_sso: z.boolean(),
    supabase_custom_auth_domain: z.boolean(),
    realtime: z.boolean(),
    lms_sync: z.boolean(),
  }),
  limits: z.object({
    max_institutions: z.number().int().positive(),
    max_active_students: z.number().int().positive(),
    database_soft_limit_mb: z.number().int().positive(),
    storage_soft_limit_mb: z.number().int().positive(),
    max_upload_mb: z.number().int().positive(),
  }),
});

export type PlanProfile = z.infer<typeof profileSchema>;
export type Role = z.infer<typeof roles>;

const OVERRIDE_PREFIX = "HBE__";

/**
 * Finds the repo's `config/` directory: HBE_CONFIG_DIR wins (set in Docker images); otherwise
 * search upward from the working directory, then from this file (bundled builds move this file).
 */
export function defaultConfigDir(): string {
  const starts = [process.cwd(), dirname(fileURLToPath(import.meta.url))];
  for (const start of starts) {
    let dir = start;
    for (;;) {
      if (existsSync(resolve(dir, "config", "profiles"))) return resolve(dir, "config");
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error("Could not find config/profiles; set HBE_CONFIG_DIR");
}

/** Values in env overrides are parsed as JSON when possible (numbers, booleans, arrays), else kept as strings. */
function parseOverrideValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Applies HBE__<SECTION>__<KEY>=value overrides onto a profile object.
 * Only existing keys can be overridden, so a typo fails loudly instead of being ignored.
 */
export function applyOverrides(
  base: Record<string, unknown>,
  env: Record<string, string | undefined>,
): Record<string, unknown> {
  const result = structuredClone(base);
  for (const [name, raw] of Object.entries(env)) {
    if (!name.startsWith(OVERRIDE_PREFIX) || raw === undefined) continue;
    const path = name.slice(OVERRIDE_PREFIX.length).toLowerCase().split("__");
    let node: Record<string, unknown> = result;
    for (const [i, key] of path.entries()) {
      if (!(key in node)) {
        throw new Error(`Unknown config override ${name}: "${path.slice(0, i + 1).join(".")}" is not a profile key`);
      }
      if (i === path.length - 1) {
        node[key] = parseOverrideValue(raw);
      } else {
        node = node[key] as Record<string, unknown>;
      }
    }
  }
  return result;
}

export function loadProfile(
  name: string,
  env: Record<string, string | undefined>,
  configDir = env.HBE_CONFIG_DIR ?? defaultConfigDir(),
): PlanProfile {
  const file = resolve(configDir, "profiles", `${name}.yaml`);
  const base = parseYaml(readFileSync(file, "utf8")) as Record<string, unknown>;
  const parsed = profileSchema.safeParse(applyOverrides(base, env));
  if (!parsed.success) {
    throw new Error(`Invalid plan profile "${name}" (${file}):\n${formatIssues(parsed.error)}`);
  }
  return parsed.data;
}

export function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
}
