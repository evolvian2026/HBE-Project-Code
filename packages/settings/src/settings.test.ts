import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSettings } from "./index.ts";
import { defaultConfigDir } from "./profile.ts";

const demo = {
  HBE_ENV: "demo",
  HBE_PLAN_PROFILE: "free",
  ROLES: "web,api,worker",
  APP_URL: "https://app.example.com",
  API_URL: "https://api.example.com",
  SUPABASE_URL: "https://abc.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_x",
  SUPABASE_SECRET_KEY: "sb_secret_x",
  DATABASE_URL: "postgresql://u:p@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres",
  QUEUE_DATABASE_URL: "postgresql://u:p@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres",
  GITHUB_APP_ID: "1",
  GITHUB_APP_PRIVATE_KEY_BASE64: "a2V5",
  GITHUB_WEBHOOK_SECRET: "s",
  GITHUB_APP_SLUG: "hbe-demo",
  GRADER_REPO: "hbe-demo-org/hbe-grader",
  ARCHIVE_S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
  ARCHIVE_S3_BUCKET: "hbe-archive",
  ARCHIVE_S3_ACCESS_KEY_ID: "k",
  ARCHIVE_S3_SECRET_ACCESS_KEY: "s",
  EMAIL_PROVIDER: "resend",
  RESEND_API_KEY: "re_x",
  EMAIL_FROM: "HBE <no-reply@example.com>",
  TOKEN_ENCRYPTION_KEY: "k",
};

/** The documented migration: only these keys change between demo and AWS production. */
const awsChanges = {
  HBE_ENV: "production",
  HBE_PLAN_PROFILE: "paid",
  ROLES: "worker",
  ARCHIVE_S3_ENDPOINT: "",
  ARCHIVE_S3_REGION: "ap-southeast-1",
  ARCHIVE_S3_BUCKET: "hbe-prod-archive-sg",
  ARCHIVE_S3_ACCESS_KEY_ID: "",
  ARCHIVE_S3_SECRET_ACCESS_KEY: "",
  ARCHIVE_OBJECT_LOCK: "governance",
};

describe("loadSettings", () => {
  it("loads the free-tier demo configuration", () => {
    const s = loadSettings(demo);
    expect(s.profile.profile).toBe("free");
    expect([...s.roles]).toEqual(["web", "api", "worker"]);
    expect(s.profile.evaluation.runner).toBe("github_hosted");
    expect(s.profile.backups.strategy).toBe("pg_dump_to_archive");
    expect(s.derived.archiveUsesInstanceRole).toBe(false);
  });

  it("switches to AWS + Supabase Pro by changing config only", () => {
    const s = loadSettings({ ...demo, ...awsChanges });
    expect(s.profile.profile).toBe("paid");
    expect(s.profile.evaluation.runner).toBe("self_hosted");
    expect(s.profile.backups.strategy).toBe("supabase_pitr");
    expect(s.profile.features.saml_sso).toBe(true);
    expect(s.derived.archiveUsesInstanceRole).toBe(true);
    expect(s.derived.isProduction).toBe(true);
  });

  it("applies HBE__SECTION__KEY overrides with type checking", () => {
    const s = loadSettings({ ...demo, HBE__EVALUATION__RUNS_PER_STUDENT_PER_DAY: "8" });
    expect(s.profile.evaluation.runs_per_student_per_day).toBe(8);
    expect(() => loadSettings({ ...demo, HBE__EVALUATION__RUNS_PER_STUDENT_PER_DAY: "lots" })).toThrow(
      /runs_per_student_per_day/,
    );
    expect(() => loadSettings({ ...demo, HBE__EVALUATION__TYPO: "1" })).toThrow(/Unknown config override/);
  });

  it("rejects provider hostnames so the domain cutover keeps working", () => {
    expect(() => loadSettings({ ...demo, API_URL: "https://hbe-app.onrender.com" })).toThrow(/own domain/);
  });

  it("requires keys for a custom S3 endpoint but not for AWS instance roles", () => {
    expect(() => loadSettings({ ...demo, ARCHIVE_S3_ACCESS_KEY_ID: "" })).toThrow(/ARCHIVE_S3_ACCESS_KEY_ID/);
  });

  it("only requires what each role needs", () => {
    const webOnly = { ...demo, ROLES: "web", GITHUB_APP_ID: "", RESEND_API_KEY: "", SUPABASE_SECRET_KEY: "" };
    expect(() => loadSettings(webOnly)).not.toThrow();
    expect(() => loadSettings({ ...webOnly, ROLES: "worker" })).toThrow(/GITHUB_APP_ID/);
  });

  it("only allows the fake GitHub locally", () => {
    expect(() => loadSettings({ ...demo, GITHUB_FAKE: "true" })).toThrow(/GITHUB_FAKE is only allowed/);
    expect(loadSettings({ ...demo, HBE_ENV: "local", GITHUB_FAKE: "true" }).env.GITHUB_FAKE).toBe(true);
  });

  it("keeps both plan profiles in sync (same keys)", () => {
    const keys = (name: string) =>
      readFileSync(resolve(defaultConfigDir(), "profiles", `${name}.yaml`), "utf8")
        .split("\n")
        .filter((l) => /^\s*[a-z_]+:/.test(l))
        .map((l) => l.trim().split(":")[0]);
    expect(keys("paid")).toEqual(keys("free"));
  });
});
