import { envSchema, validateEnv, type Env } from "./env.ts";
import { formatIssues, loadProfile, type PlanProfile, type Role } from "./profile.ts";

export type { Env, PlanProfile, Role };

export interface Settings {
  env: Env;
  profile: PlanProfile;
  roles: Set<Role>;
  /** Values computed from the env, so callers don't repeat the logic. */
  derived: {
    archiveUsesInstanceRole: boolean;
    isProduction: boolean;
  };
}

const ROLE_NAMES = new Set<Role>(["web", "api", "worker"]);

function parseRoles(raw: string | undefined, fallback: Role[]): Set<Role> {
  if (!raw) return new Set(fallback);
  const roles = raw
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  const unknown = roles.filter((r) => !ROLE_NAMES.has(r as Role));
  if (unknown.length) throw new Error(`Unknown ROLES: ${unknown.join(", ")} (expected web, api, worker)`);
  return new Set(roles as Role[]);
}

/**
 * Loads and validates all configuration once at process start. Throws with every problem
 * listed, so a misconfigured deploy fails its health check instead of misbehaving later.
 */
export function loadSettings(source: Record<string, string | undefined> = process.env): Settings {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid environment:\n${formatIssues(parsed.error)}`);
  }
  const env = parsed.data;
  const profile = loadProfile(env.HBE_PLAN_PROFILE, source);
  const roles = parseRoles(env.ROLES, profile.runtime.default_roles);

  const problems = validateEnv(env, roles);
  if (problems.length) {
    throw new Error(
      `Invalid configuration (HBE_ENV=${env.HBE_ENV}, profile=${profile.profile}):\n  - ${problems.join("\n  - ")}`,
    );
  }

  return {
    env,
    profile,
    roles,
    derived: {
      archiveUsesInstanceRole: !env.ARCHIVE_S3_ENDPOINT && !env.ARCHIVE_S3_ACCESS_KEY_ID,
      isProduction: env.HBE_ENV === "production",
    },
  };
}

/** Summary safe to log at startup: no secrets, only which knobs are in effect. */
export function describeSettings(s: Settings): Record<string, unknown> {
  return {
    env: s.env.HBE_ENV,
    profile: s.profile.profile,
    roles: [...s.roles],
    app_url: s.env.APP_URL,
    api_url: s.env.API_URL,
    supabase_host: new URL(s.env.SUPABASE_URL).host,
    runner: s.profile.evaluation.runner,
    backups: s.profile.backups.strategy,
    archive: s.env.ARCHIVE_S3_BUCKET
      ? `${s.env.ARCHIVE_S3_ENDPOINT ? new URL(s.env.ARCHIVE_S3_ENDPOINT).host : "aws-s3"}/${s.env.ARCHIVE_S3_BUCKET} (lock=${s.env.ARCHIVE_OBJECT_LOCK})`
      : "disabled",
    email: s.env.EMAIL_PROVIDER,
  };
}
