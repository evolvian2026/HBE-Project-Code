import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { FakeQueue, FakeVerifier, Fixtures, testDb, testSettings } from "./helpers.ts";
import { createScenario, sha } from "./scenario.ts";

const db = testDb();
const fixtures = new Fixtures(db);
const verifier = new FakeVerifier();
const settings = testSettings();
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ settings, db, queue: new FakeQueue(), verifier });
});
afterAll(async () => {
  await app.close();
  await fixtures.cleanup();
  await db.destroy();
});

const get = (url: string, userId: string, aal: "aal1" | "aal2" = "aal2") =>
  app.inject({ method: "GET", url, headers: { authorization: `Bearer ${verifier.tokenFor(userId, aal)}` } });

describe("usage", () => {
  it("shows an institution's admins what it used this month, against its limits", async () => {
    const s = await createScenario(db, fixtures);
    const admin = await fixtures.user();
    await db
      .insertInto("institution_memberships")
      .values({ institution_id: s.institutionId, user_id: admin, role: "admin", external_id: null })
      .execute();
    await db
      .updateTable("institutions")
      .set({ limits: JSON.stringify({ max_active_students: 40, monthly_runner_minutes: 100 }) })
      .where("id", "=", s.institutionId)
      .execute();
    // A 10-minute run and a queued one this month; a 2 MB source snapshot.
    const run = await db
      .insertInto("evaluation_runs")
      .values({
        institution_id: s.institutionId,
        submission_id: s.submissionId,
        sha: sha(),
        trigger: "push",
        status: "completed",
        started_at: new Date(Date.now() - 10 * 60_000),
        finished_at: new Date(),
        callback_token_hash: null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await db
      .insertInto("evaluation_runs")
      .values({
        institution_id: s.institutionId,
        submission_id: s.submissionId,
        sha: sha(),
        trigger: "manual",
        callback_token_hash: null,
      })
      .execute();
    await db
      .insertInto("submission_snapshots")
      .values({
        institution_id: s.institutionId,
        submission_id: s.submissionId,
        sha: sha(),
        run_id: run.id,
        bundle_path: "b",
        bundle_sha256: "a".repeat(64),
        bundle_size: 1_000_000,
        tarball_path: "t",
        tarball_sha256: "b".repeat(64),
        tarball_size: 1_000_000,
      })
      .execute();
    const url = `/v1/institutions/${s.institutionId}/usage`;

    expect((await get(url, s.instructor)).statusCode).toBe(403); // teachers don't
    expect((await get(url, admin, "aal1")).statusCode).toBe(403); // admins need MFA
    const res = await get(url, admin);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      month: new Date().toISOString().slice(0, 7),
      runnerMinutes: { used: 11, allowance: 100 }, // rounded up, plus a minute of setup
      runs: { push: 1, manual: 1 },
      students: { active: 2, invited: 0, limit: 40 },
      storageBytes: { snapshots: 2_000_000, artifacts: 0, exports: 0 },
      emails: { sent: 0, failed: 0 },
    });
  });

  it("gives super admins the platform's health", async () => {
    const operator = await fixtures.user({ superAdmin: true });
    const s = await createScenario(db, fixtures);
    expect((await get("/v1/platform/health", s.instructor)).statusCode).toBe(403);
    const res = await get("/v1/platform/health", operator);
    expect(res.statusCode).toBe(200);
    const h = res.json();
    expect(h).toMatchObject({
      runs: { concurrency: settings.profile.evaluation.global_concurrency },
      runnerMinutes: { budget: settings.profile.evaluation.monthly_runner_minutes_budget },
      webhooks: { unprocessed: expect.any(Number) },
    });
    expect(Array.isArray(h.queues)).toBe(true);
    expect(h.institutions).toContainEqual(expect.objectContaining({ id: s.institutionId, students: 2, runs: 0 }));
  });
});
