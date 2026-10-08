import { z } from "zod";
import type { Role } from "./profile.ts";

const optional = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ? v : undefined));
const url = z.string().url();
const pgUrl = z.string().regex(/^postgres(ql)?:\/\//, "must be a postgres:// connection string");

export const envSchema = z.object({
  HBE_ENV: z.enum(["local", "demo", "staging", "production"]),
  HBE_PLAN_PROFILE: z.enum(["free", "paid"]),
  ROLES: optional,
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /** Built Next.js app served by the web role (defaults to apps/web relative to the server). */
  WEB_DIR: optional,
  TZ: z.string().default("Asia/Singapore"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),

  APP_URL: url,
  API_URL: url,
  /** Private address of the api role for server-side calls from web (e.g. http://api:4000). */
  INTERNAL_API_URL: url.optional(),

  SUPABASE_URL: url,
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  SUPABASE_SECRET_KEY: optional,
  DATABASE_URL: pgUrl.optional(),
  QUEUE_DATABASE_URL: pgUrl.optional(),

  GITHUB_APP_ID: optional,
  GITHUB_APP_CLIENT_ID: optional,
  GITHUB_APP_CLIENT_SECRET: optional,
  GITHUB_APP_PRIVATE_KEY_BASE64: optional,
  GITHUB_WEBHOOK_SECRET: optional,
  /** The App's URL slug (github.com/apps/<slug>), used for install links. */
  GITHUB_APP_SLUG: optional,
  /** GitHub REST base URL (GitHub Enterprise Server or tests). */
  GITHUB_API_URL: z.string().url().default("https://api.github.com"),
  /** Local development only: an in-memory GitHub instead of the real App. */
  GITHUB_FAKE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  GRADER_REPO: z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+$/, "must be owner/repo")
    .optional(),
  GRADER_WORKFLOW: z.string().default("evaluate.yml"),
  GRADER_REF: z.string().default("main"),

  ARCHIVE_S3_ENDPOINT: optional,
  ARCHIVE_S3_REGION: z.string().default("auto"),
  ARCHIVE_S3_BUCKET: optional,
  ARCHIVE_S3_ACCESS_KEY_ID: optional,
  ARCHIVE_S3_SECRET_ACCESS_KEY: optional,
  ARCHIVE_OBJECT_LOCK: z.enum(["none", "governance", "compliance"]).default("none"),

  EMAIL_PROVIDER: z.enum(["resend", "ses", "log"]).default("log"),
  EMAIL_FROM: optional,
  RESEND_API_KEY: optional,
  AWS_SES_REGION: optional,

  LTI_PRIVATE_KEY_BASE64: optional,
  LTI_KEY_ID: optional,
  GOOGLE_OAUTH_CLIENT_ID: optional,
  GOOGLE_OAUTH_CLIENT_SECRET: optional,
  TOKEN_ENCRYPTION_KEY: optional,

  SENTRY_DSN: optional,
  OTEL_EXPORTER_OTLP_ENDPOINT: optional,
});

export type Env = z.infer<typeof envSchema>;

type Rule = { when: (env: Env, roles: Set<Role>) => boolean; check: (env: Env) => string | undefined };

const required =
  (...keys: (keyof Env)[]) =>
  (env: Env) => {
    const missing = keys.filter((k) => !env[k]);
    return missing.length ? `missing ${missing.join(", ")}` : undefined;
  };

const serverSide = (_: Env, r: Set<Role>) => r.has("api") || r.has("worker");
const deployed = (env: Env) => env.HBE_ENV !== "local";

/** Cross-field rules: which variables a given role/environment needs. */
const rules: Rule[] = [
  {
    when: serverSide,
    check: required("SUPABASE_SECRET_KEY", "DATABASE_URL", "QUEUE_DATABASE_URL", "TOKEN_ENCRYPTION_KEY"),
  },
  { when: serverSide, check: required("GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY_BASE64") },
  { when: (_, r) => r.has("api"), check: required("GITHUB_WEBHOOK_SECRET", "GITHUB_APP_SLUG") },
  { when: (_, r) => r.has("worker"), check: required("GRADER_REPO", "EMAIL_FROM") },
  { when: (e, r) => r.has("worker") && e.EMAIL_PROVIDER === "resend", check: required("RESEND_API_KEY") },
  { when: (e, r) => r.has("worker") && e.EMAIL_PROVIDER === "ses", check: required("AWS_SES_REGION") },
  { when: (e, r) => r.has("worker") && deployed(e), check: required("ARCHIVE_S3_BUCKET") },
  {
    // A custom endpoint (R2, B2) has no instance role, so it needs explicit keys.
    when: (e, r) => r.has("worker") && !!e.ARCHIVE_S3_ENDPOINT,
    check: required("ARCHIVE_S3_ACCESS_KEY_ID", "ARCHIVE_S3_SECRET_ACCESS_KEY"),
  },
  {
    when: deployed,
    check: (e) =>
      [e.APP_URL, e.API_URL].some((u) => !u.startsWith("https://")) ? "APP_URL and API_URL must use https" : undefined,
  },
  {
    when: (e) => e.GITHUB_FAKE,
    check: (e) => (e.HBE_ENV === "local" ? undefined : "GITHUB_FAKE is only allowed when HBE_ENV=local"),
  },
  {
    // Provider hostnames baked into GitHub/LTI/OAuth config would break the AWS migration.
    when: deployed,
    check: (e) =>
      [e.APP_URL, e.API_URL].some((u) => /\.onrender\.com|\.amazonaws\.com|\.elb\./.test(new URL(u).hostname))
        ? "APP_URL and API_URL must be your own domain, not a provider hostname (see DEPLOYMENT.md §3)"
        : undefined,
  },
];

export function validateEnv(env: Env, roles: Set<Role>): string[] {
  return rules.filter((r) => r.when(env, roles)).flatMap((r) => r.check(env) ?? []);
}
