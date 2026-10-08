// Integration test: needs the local Supabase database (`pnpm db:start`).
// Checks that the hand-written Kysely types match the real schema.
import { afterAll, describe, expect, it } from "vitest";
import { createDb, sql } from "./index.ts";

const db = createDb({
  connectionString: process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  max: 2,
});

afterAll(() => db.destroy());

// Column names per table as declared in types.ts.
const declared: Record<string, string[]> = {
  platform_settings: ["key", "value", "description", "updated_by", "updated_at"],
  email_outbox: [
    "id",
    "institution_id",
    "to_email",
    "template",
    "payload",
    "status",
    "attempts",
    "last_error",
    "created_at",
    "sent_at",
  ],
  institutions: [
    "id",
    "name",
    "slug",
    "status",
    "limits",
    "settings",
    "contract_started_at",
    "contract_ended_at",
    "purge_after",
    "created_by",
    "created_at",
    "updated_at",
  ],
  profiles: [
    "id",
    "email",
    "full_name",
    "avatar_url",
    "github_user_id",
    "github_login",
    "status",
    "anonymised_at",
    "created_at",
    "updated_at",
  ],
  user_roles: ["user_id", "role", "granted_by", "created_at"],
  institution_memberships: [
    "id",
    "institution_id",
    "user_id",
    "role",
    "status",
    "external_id",
    "created_at",
    "updated_at",
  ],
  courses: [
    "id",
    "institution_id",
    "code",
    "name",
    "term",
    "timezone",
    "archived_at",
    "github_installation_id",
    "created_by",
    "created_at",
    "updated_at",
  ],
  course_memberships: [
    "id",
    "institution_id",
    "course_id",
    "user_id",
    "role",
    "section",
    "source",
    "created_at",
    "updated_at",
  ],
  invitations: [
    "id",
    "institution_id",
    "email",
    "github_login",
    "role",
    "course_id",
    "course_role",
    "token_hash",
    "invited_by",
    "expires_at",
    "accepted_at",
    "accepted_by",
    "created_at",
  ],
  audit_logs: ["id", "institution_id", "actor_id", "action", "entity", "entity_id", "before", "after", "ip", "at"],
  github_installations: [
    "id",
    "institution_id",
    "installation_id",
    "account_id",
    "account_login",
    "account_type",
    "repository_selection",
    "permissions",
    "events",
    "suspended_at",
    "deleted_at",
    "linked_at",
    "linked_by",
    "created_at",
    "updated_at",
  ],
  github_link_requests: [
    "id",
    "institution_id",
    "requested_by",
    "github_user_id",
    "expires_at",
    "completed_at",
    "installation_id",
    "created_at",
  ],
  github_events: [
    "id",
    "delivery_id",
    "event",
    "action",
    "installation_id",
    "institution_id",
    "repository_full_name",
    "sender_id",
    "payload",
    "received_at",
    "processed_at",
    "attempts",
    "error",
  ],
};

describe("Kysely types match the database", () => {
  it("covers every public table, and every column exists in both", async () => {
    const { rows } = await sql<{ table_name: string; column_name: string }>`
      select table_name, column_name from information_schema.columns
      where table_schema = 'public' and table_name in (
        select tablename from pg_tables where schemaname = 'public')
      order by table_name, ordinal_position`.execute(db);

    const actual: Record<string, string[]> = {};
    for (const r of rows) (actual[r.table_name] ??= []).push(r.column_name);

    expect(Object.keys(actual).sort()).toEqual(Object.keys(declared).sort());
    for (const [table, columns] of Object.entries(declared)) {
      expect(actual[table]?.slice().sort(), table).toEqual(columns.slice().sort());
    }
  });

  it("returns int8 columns as numbers", async () => {
    const { rows } = await sql<{ n: number }>`select 9007199254740991::int8 as n`.execute(db);
    expect(rows[0]?.n).toBe(Number.MAX_SAFE_INTEGER);
    await expect(sql`select 9007199254740993::int8 as n`.execute(db)).rejects.toThrow(RangeError);
  });
});
