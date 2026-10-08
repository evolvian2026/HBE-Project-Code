import { randomInt, randomUUID } from "node:crypto";
import { createDb, sql, type Db } from "@hbe/db";
import type { Job, JobQueue, QueueName, QueuePayloads, SendOptions } from "@hbe/queue";
import { loadSettings, type Settings } from "@hbe/settings";
import type { TokenVerifier } from "../src/auth.ts";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
export const WEBHOOK_SECRET = "test-webhook-secret";

export function testSettings(overrides: Record<string, string> = {}): Settings {
  return loadSettings({
    HBE_ENV: "local",
    HBE_PLAN_PROFILE: "free",
    ROLES: "api,worker",
    APP_URL: "http://localhost:3000",
    API_URL: "http://localhost:4000",
    SUPABASE_URL: "http://127.0.0.1:54321",
    SUPABASE_PUBLISHABLE_KEY: "test",
    SUPABASE_SECRET_KEY: "test",
    DATABASE_URL: TEST_DATABASE_URL,
    QUEUE_DATABASE_URL: TEST_DATABASE_URL,
    GITHUB_APP_ID: "1",
    GITHUB_APP_PRIVATE_KEY_BASE64: "eA==",
    GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
    GITHUB_APP_SLUG: "hbe-test",
    GRADER_REPO: "hbe-test/hbe-grader",
    EMAIL_FROM: "HBE <test@example.com>",
    TOKEN_ENCRYPTION_KEY: "test",
    ...overrides,
  });
}

export function testDb(): Db {
  return createDb({ connectionString: TEST_DATABASE_URL, max: 4 });
}

/** Records sends instead of talking to pg-boss. */
export class FakeQueue implements JobQueue {
  sent: { name: QueueName; data: unknown; options?: SendOptions }[] = [];
  async start() {}
  async stop() {}
  async send<N extends QueueName>(name: N, data: QueuePayloads[N], options?: SendOptions): Promise<string> {
    this.sent.push({ name, data, ...(options ? { options } : {}) });
    return randomUUID();
  }
  async work<N extends QueueName>(_name: N, _handler: (job: Job<N>) => Promise<void>) {}
  async schedule() {}
}

/** Maps opaque test tokens to user ids. */
export class FakeVerifier implements TokenVerifier {
  private tokens = new Map<string, string>();
  private aals = new Map<string, string>();
  /** Sessions are MFA-verified (aal2) unless stated otherwise. */
  tokenFor(userId: string, aal: "aal1" | "aal2" = "aal2"): string {
    const token = `token-${randomUUID()}`;
    this.tokens.set(token, userId);
    this.aals.set(token, aal);
    return token;
  }
  async verify(token: string) {
    const userId = this.tokens.get(token);
    return userId ? { userId, aal: this.aals.get(token) ?? "aal1" } : null;
  }
}

export const unique = () => randomUUID().slice(0, 8);
export const randomGithubId = () => randomInt(100_000_000, 2_000_000_000);

/** Fixture tracker so each test file cleans up exactly what it created. */
export class Fixtures {
  userIds: string[] = [];
  institutionIds: string[] = [];
  installationIds: number[] = [];
  deliveryIds: string[] = [];

  constructor(private readonly db: Db) {}

  async user(
    opts: { email?: string; githubId?: number; githubLogin?: string; superAdmin?: boolean } = {},
  ): Promise<string> {
    const id = randomUUID();
    const email = opts.email ?? `user-${unique()}@test.local`;
    await sql`
      insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
      values (${id}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', ${email}, now(),
              '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now())`.execute(this.db);
    if (opts.githubId) {
      await sql`
        insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at, last_sign_in_at)
        values (${String(opts.githubId)}, ${id},
                ${JSON.stringify({ sub: String(opts.githubId), user_name: opts.githubLogin ?? `gh-${unique()}` })}::jsonb,
                'github', now(), now(), now())`.execute(this.db);
    }
    if (opts.superAdmin)
      await this.db.insertInto("user_roles").values({ user_id: id, role: "super_admin", granted_by: null }).execute();
    this.userIds.push(id);
    return id;
  }

  async institution(
    members: { userId: string; role: "admin" | "teacher" | "student" }[] = [],
  ): Promise<{ id: string; slug: string }> {
    const slug = `test-${unique()}`;
    const inst = await this.db
      .insertInto("institutions")
      .values({ name: `Test ${slug}`, slug, created_by: null })
      .returning(["id", "slug"])
      .executeTakeFirstOrThrow();
    this.institutionIds.push(inst.id);
    if (members.length) {
      await this.db
        .insertInto("institution_memberships")
        .values(members.map((m) => ({ institution_id: inst.id, user_id: m.userId, role: m.role, external_id: null })))
        .execute();
    }
    return inst;
  }

  async cleanup(): Promise<void> {
    // Order matters: institutions first (cascading to courses and repositories that
    // reference installations), then installations, then users.
    if (this.deliveryIds.length)
      await this.db.deleteFrom("github_events").where("delivery_id", "in", this.deliveryIds).execute();
    if (this.institutionIds.length) {
      await this.db.deleteFrom("institutions").where("id", "in", this.institutionIds).execute();
      await this.db.deleteFrom("audit_logs").where("institution_id", "in", this.institutionIds).execute();
    }
    if (this.installationIds.length) {
      await this.db.deleteFrom("github_events").where("installation_id", "in", this.installationIds).execute();
      await this.db.deleteFrom("github_installations").where("installation_id", "in", this.installationIds).execute();
    }
    if (this.userIds.length) await sql`delete from auth.users where id in (${sql.join(this.userIds)})`.execute(this.db);
  }
}
