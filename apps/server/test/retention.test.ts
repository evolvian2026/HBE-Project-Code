import { randomUUID } from "node:crypto";
import { sql } from "@hbe/db";
import { afterAll, describe, expect, it } from "vitest";
import { MemoryArchiveStore } from "../src/archive.ts";
import { MemoryObjectStore } from "../src/storage.ts";
import { sweepRetention } from "../src/worker/retention.ts";
import { Fixtures, testDb, testSettings } from "./helpers.ts";

const db = testDb();
const fixtures = new Fixtures(db);
afterAll(async () => {
  await fixtures.cleanup();
  await db.destroy();
});

const DAY = 86_400_000;

describe("the retention sweep", () => {
  it("deletes processed webhooks, old emails, long-read notifications and old exports, and nothing else", async () => {
    const settings = testSettings(); // free profile: webhooks 7 days, emails 14, notifications 180, exports 14
    const user = await fixtures.user();
    const inst = await fixtures.institution([{ userId: user, role: "admin" }]);
    const now = new Date();
    const ago = (days: number) => new Date(now.getTime() - days * DAY);
    const tag = randomUUID();

    // Webhooks: processed and old (gone), processed and recent, unprocessed and old (kept).
    for (const [age, processed] of [
      [10, true],
      [2, true],
      [10, false],
    ] as const) {
      await sql`insert into github_events (delivery_id, event, institution_id, payload, received_at, processed_at)
                values (${`${tag}-${age}-${processed}`}, 'push', ${inst.id}, '{"sender": {"login": "ada"}}',
                        ${ago(age)}, ${processed ? ago(age) : null})`.execute(db);
    }
    // Emails: sent and old (gone), failed and old (gone), sent recently and pending and old (kept).
    for (const [age, status] of [
      [20, "sent"],
      [20, "failed"],
      [3, "sent"],
      [20, "pending"],
    ] as const) {
      await sql`insert into email_outbox (institution_id, to_email, template, status, created_at)
                values (${inst.id}, ${`${tag}@test.local`}, 'invitation', ${status}, ${ago(age)})`.execute(db);
    }
    // Notifications: read long ago (gone), read recently and unread (kept).
    for (const [created, read] of [
      [400, 200],
      [400, 10],
      [400, null],
    ] as const) {
      await sql`insert into notifications (institution_id, user_id, type, title, created_at, read_at)
                values (${inst.id}, ${user}, 'grade_released', ${tag}, ${ago(created)}, ${read === null ? null : ago(read)})`.execute(
        db,
      );
    }
    // Exports: an old one in Storage and one in the archive (gone, with their files), a recent one and a running one.
    const store = new MemoryObjectStore();
    const archive = new MemoryArchiveStore();
    await store.put("record-exports", `${inst.id}/old.zip`, Buffer.from("zip"), "application/zip");
    await store.put("record-exports", `${inst.id}/new.zip`, Buffer.from("zip"), "application/zip");
    await archive.put(`exports/${inst.id}/old.zip`, Buffer.from("zip"), { contentType: "application/zip" });
    for (const [age, status, location, path] of [
      [20, "ready", "storage", `${inst.id}/old.zip`],
      [20, "ready", "archive", `exports/${inst.id}/old.zip`],
      [20, "failed", null, null],
      [3, "ready", "storage", `${inst.id}/new.zip`],
      [20, "running", null, null],
    ] as const) {
      await sql`insert into record_exports (institution_id, status, location, path, created_at)
                values (${inst.id}, ${status}, ${location}, ${path}, ${ago(age)})`.execute(db);
    }

    const result = await sweepRetention({ db, store, archive, settings }, now);
    expect(result.webhookEvents).toBeGreaterThanOrEqual(1);
    expect(result.emails).toBeGreaterThanOrEqual(2);
    expect(result.notifications).toBeGreaterThanOrEqual(1);
    expect(result.exports).toBeGreaterThanOrEqual(3);

    const left = async (q: ReturnType<typeof sql<{ n: number }>>) => (await q.execute(db)).rows[0]!.n;
    expect(await left(sql`select count(*)::int as n from github_events where delivery_id like ${`${tag}%`}`)).toBe(2);
    expect(
      (
        await sql<{
          delivery_id: string;
        }>`select delivery_id from github_events where delivery_id like ${`${tag}%`} order by 1`.execute(db)
      ).rows.map((r) => r.delivery_id.slice(tag.length + 1)),
    ).toEqual(["10-false", "2-true"]);
    expect(
      (
        await sql<{
          status: string;
        }>`select status from email_outbox where to_email = ${`${tag}@test.local`} order by 1`.execute(db)
      ).rows.map((r) => r.status),
    ).toEqual(["pending", "sent"]);
    expect(await left(sql`select count(*)::int as n from notifications where title = ${tag}`)).toBe(2);
    expect(
      (
        await sql<{
          status: string;
        }>`select status from record_exports where institution_id = ${inst.id} order by 1`.execute(db)
      ).rows.map((r) => r.status),
    ).toEqual(["ready", "running"]);
    expect([...store.objects.keys()]).toEqual([`record-exports/${inst.id}/new.zip`]);
    expect(archive.objects.size).toBe(0);
  });
});
