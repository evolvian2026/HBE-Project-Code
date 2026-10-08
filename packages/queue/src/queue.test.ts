// Integration test: needs the local Supabase database (`pnpm db:start`).
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgBossQueue, type Job } from "./index.ts";

const connectionString = process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const schema = `pgboss_test_${randomUUID().slice(0, 8)}`;
const queue = new PgBossQueue({
  connectionString,
  max: 2,
  schema,
  timezone: "Asia/Singapore",
  archiveDays: 1,
  pollingIntervalSeconds: 0.5,
  runsMaintenance: true,
});

beforeAll(() => queue.start());

afterAll(async () => {
  await queue.stop();
  const client = new pg.Client({ connectionString });
  await client.connect();
  await client.query(`drop schema if exists ${schema} cascade`);
  await client.end();
});

describe("PgBossQueue", () => {
  it("delivers a typed job to its worker", async () => {
    const received = new Promise<Job<"github-event">>((resolve) => {
      void queue.work("github-event", async (job) => resolve(job));
    });
    const id = await queue.send("github-event", { eventId: 42 });
    const job = await received;
    expect(job.id).toBe(id);
    expect(job.data).toEqual({ eventId: 42 });
  });

  it("de-duplicates jobs with the same singleton key", async () => {
    const first = await queue.send("github-events-sweep", {}, { singletonKey: "sweep", startAfterSeconds: 60 });
    const second = await queue.send("github-events-sweep", {}, { singletonKey: "sweep", startAfterSeconds: 60 });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });
});
