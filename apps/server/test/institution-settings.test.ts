import { FakeGitHub } from "@hbe/github";
import type { Settings } from "@hbe/settings";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { dispatchRun } from "../src/worker/evaluation.ts";
import { FakeQueue, FakeVerifier, Fixtures, testDb, testSettings } from "./helpers.ts";
import { createScenario, sha, type Scenario } from "./scenario.ts";

const db = testDb();
const fixtures = new Fixtures(db);
const verifier = new FakeVerifier();
const settings = testSettings({ GRADER_CALLBACK_AUTH: "token" });
const log = Fastify({ logger: false }).log;
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ settings, db, queue: new FakeQueue(), verifier });
});
afterAll(async () => {
  await app.close();
  await fixtures.cleanup();
  await db.destroy();
});

const as = (userId: string, aal: "aal1" | "aal2" = "aal2") => ({
  authorization: `Bearer ${verifier.tokenFor(userId, aal)}`,
});
const defaults = {
  run_quota_per_day: 3,
  weights: { automated: 50, rubric: 30, process: 20 },
  late_policy: { per_day_percent: 20, max_days: 2, grace_minutes: 10 },
  regrade_window_days: 3,
  triggers: { on_push: true, on_pull_request: false, manual: true },
  post_feedback_to_github: true,
};

/** Plenty of room on the plan, so other tests' runs don't get in the way. */
const roomy: Settings = {
  ...settings,
  profile: {
    ...settings.profile,
    evaluation: {
      ...settings.profile.evaluation,
      global_concurrency: 1000,
      institution_concurrency: 1000,
      monthly_runner_minutes_budget: 1_000_000,
    },
  },
};
const queuedRun = async (s: Scenario, trigger: "manual" | "push") =>
  db
    .insertInto("evaluation_runs")
    .values({
      institution_id: s.institutionId,
      submission_id: s.submissionId,
      sha: sha(),
      trigger,
      grader_suite_id: (
        await db.selectFrom("assignments").select("grader_suite_id").where("id", "=", s.assignmentId).executeTakeFirst()
      )?.grader_suite_id,
      stack_profile_id: null,
      requested_by: null,
      callback_token_hash: null,
    })
    .returning("id")
    .executeTakeFirstOrThrow();

describe("institution settings", () => {
  it("are chosen by the institution's admins (with MFA), validated and audited", async () => {
    const admin = await fixtures.user();
    const teacher = await fixtures.user();
    const inst = await fixtures.institution([
      { userId: admin, role: "admin" },
      { userId: teacher, role: "teacher" },
    ]);
    const put = (userId: string, payload: object, aal: "aal1" | "aal2" = "aal2") =>
      app.inject({ method: "PUT", url: `/v1/institutions/${inst.id}/settings`, headers: as(userId, aal), payload });

    expect((await put(teacher, { assignmentDefaults: defaults })).statusCode).toBe(403);
    expect((await put(admin, { assignmentDefaults: defaults }, "aal1")).statusCode).toBe(403);
    const bad = await put(admin, {
      assignmentDefaults: { ...defaults, weights: { automated: 50, rubric: 50, process: 50 } },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toMatch(/add up to 100/);
    expect((await put(admin, { assignmentDefaults: { ...defaults, surprise: 1 } })).statusCode).toBe(400);

    const ok = await put(admin, { name: "Alpha Polytechnic", assignmentDefaults: defaults });
    expect(ok.statusCode).toBe(200);
    const row = await db
      .selectFrom("institutions")
      .select(["name", "settings"])
      .where("id", "=", inst.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      name: "Alpha Polytechnic",
      settings: { assignment_defaults: defaults, hidden_stack_profiles: [] },
    });
    const audit = await db
      .selectFrom("audit_logs")
      .select(["actor_id", "entity"])
      .where("institution_id", "=", inst.id)
      .where("entity", "=", "institutions")
      .orderBy("id", "desc")
      .executeTakeFirstOrThrow();
    expect(audit).toEqual({ actor_id: admin, entity: "institutions" });
  });
});

describe("institution limits", () => {
  it("are set by super admins, and only tighten the plan", async () => {
    const operator = await fixtures.user({ superAdmin: true });
    const admin = await fixtures.user();
    const inst = await fixtures.institution([{ userId: admin, role: "admin" }]);
    const put = (userId: string, payload: object) =>
      app.inject({ method: "PUT", url: `/v1/platform/institutions/${inst.id}/limits`, headers: as(userId), payload });
    const plan = settings.profile.evaluation;

    expect(
      (await put(admin, { maxActiveStudents: 10, institutionConcurrency: null, monthlyRunnerMinutes: null }))
        .statusCode,
    ).toBe(403);
    const tooMuch = await put(operator, {
      maxActiveStudents: null,
      institutionConcurrency: plan.institution_concurrency + 1,
      monthlyRunnerMinutes: null,
    });
    expect(tooMuch.statusCode).toBe(400);
    expect(tooMuch.body).toMatch(/the plan's limit/);

    const ok = await put(operator, { maxActiveStudents: 120, institutionConcurrency: 1, monthlyRunnerMinutes: 600 });
    expect(ok.json()).toEqual({
      limits: { max_active_students: 120, institution_concurrency: 1, monthly_runner_minutes: 600 },
    });
    const list = await app.inject({ method: "GET", url: "/v1/platform/institutions", headers: as(operator) });
    expect(list.json().institutions.find((i: { id: string }) => i.id === inst.id)).toMatchObject({
      limits: { max_active_students: 120, institution_concurrency: 1, monthly_runner_minutes: 600 },
      student_count: 0,
    });
    expect(list.json().plan).toEqual({
      institutionConcurrency: plan.institution_concurrency,
      monthlyRunnerMinutes: plan.monthly_runner_minutes_budget,
    });

    // Null removes a limit.
    await put(operator, { maxActiveStudents: null, institutionConcurrency: null, monthlyRunnerMinutes: null });
    expect(
      (await db.selectFrom("institutions").select("limits").where("id", "=", inst.id).executeTakeFirstOrThrow()).limits,
    ).toEqual({});
  });

  it("hold back test runs: at most N at once, and automatic runs stop at the monthly minutes", async () => {
    const s = await createScenario(db, fixtures);
    const github = new FakeGitHub();
    const deps = { db, queue: new FakeQueue(), github, settings: roomy, log };
    await db
      .updateTable("institutions")
      .set({ limits: JSON.stringify({ institution_concurrency: 1 }) })
      .where("id", "=", s.institutionId)
      .execute();
    const first = await queuedRun(s, "manual");
    const second = await queuedRun(s, "manual");
    expect(await dispatchRun(deps, first.id)).toBe("dispatched");
    expect(await dispatchRun(deps, second.id)).toBe("deferred"); // the plan would allow 1000

    // 10 minutes used this month, against an allowance of 5.
    await db
      .updateTable("evaluation_runs")
      .set({ status: "completed", started_at: new Date(Date.now() - 10 * 60_000), finished_at: new Date() })
      .where("id", "=", first.id)
      .execute();
    await db
      .updateTable("institutions")
      .set({ limits: JSON.stringify({ monthly_runner_minutes: 5 }) })
      .where("id", "=", s.institutionId)
      .execute();
    const push = await queuedRun(s, "push");
    expect(await dispatchRun(deps, push.id)).toBe("cancelled");
    expect(await dispatchRun(deps, second.id)).toBe("dispatched"); // asked for: still goes
  });
});
