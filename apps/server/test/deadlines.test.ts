import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { tokenGraderAuth } from "../src/grader-auth.ts";
import { handlePush } from "../src/worker/activity.ts";
import { finalizeDueSubmissions } from "../src/worker/deadlines.ts";
import { reapRuns, retryGradedRun } from "../src/worker/evaluation.ts";
import { FakeQueue, FakeVerifier, Fixtures, testDb, testSettings } from "./helpers.ts";
import { createScenario, pushEvent, sha, type Scenario, type ScenarioOptions } from "./scenario.ts";

const db = testDb();
const fixtures = new Fixtures(db);
const settings = testSettings({ GRADER_CALLBACK_AUTH: "token" });
const log = Fastify({ logger: false }).log;
const verifier = new FakeVerifier();
const HOUR = 3_600_000;
const noLate = { per_day_percent: 10, max_days: 0, grace_minutes: 15 };

const scenario = (opts: ScenarioOptions = {}) => createScenario(db, fixtures, opts);
const deps = () => ({ db, queue: new FakeQueue(), settings, log });
const at = (d: Date) => Math.floor(d.getTime() / 1000);
const submission = (s: Scenario) =>
  db.selectFrom("submissions").selectAll().where("id", "=", s.submissionId).executeTakeFirstOrThrow();
const runs = (s: Scenario) =>
  db
    .selectFrom("evaluation_runs")
    .selectAll()
    .where("submission_id", "=", s.submissionId)
    .orderBy("queued_at")
    .execute();

afterAll(async () => {
  await fixtures.cleanup();
  await db.destroy();
});

describe("push history", () => {
  it("records default-branch pushes with GitHub's push time", async () => {
    const s = await scenario();
    const pushedAt = new Date(Date.now() - 5 * HOUR);
    const head = sha();
    await handlePush(deps(), { ...pushEvent(s, head, { pushedAt: at(pushedAt) }), forced: true });
    await handlePush(deps(), pushEvent(s, sha(), { bot: true }));
    await handlePush(deps(), pushEvent(s, sha(), { ref: "refs/heads/feature" }));
    const pushes = await db
      .selectFrom("branch_pushes")
      .selectAll()
      .where("repository_id", "=", s.repositoryId)
      .orderBy("pushed_at")
      .execute();
    expect(pushes).toHaveLength(2);
    expect(pushes[0]).toMatchObject({ sha: head, forced: true, by_bot: false, pusher_github_id: 2 });
    expect(new Date(pushes[0]!.pushed_at).getTime()).toBe(at(pushedAt) * 1000);
    expect(pushes[1]).toMatchObject({ by_bot: true });
  });
});

describe("finalizing at the cutoff", () => {
  it("grades the head as of the deadline plus grace, by push time", async () => {
    const deadline = new Date(Date.now() - 2 * HOUR);
    const s = await scenario({ dueAt: deadline, latePolicy: noLate });
    const early = sha();
    const inGrace = sha();
    const tooLate = sha();
    await handlePush(deps(), pushEvent(s, early, { pushedAt: at(new Date(deadline.getTime() - HOUR)) }));
    await handlePush(deps(), pushEvent(s, inGrace, { pushedAt: at(new Date(deadline.getTime() + 10 * 60_000)) }));
    await handlePush(deps(), pushEvent(s, tooLate, { pushedAt: at(new Date(deadline.getTime() + 30 * 60_000)) }));
    // A bot's push inside the window doesn't count as the student's submission.
    await handlePush(
      deps(),
      pushEvent(s, sha(), { pushedAt: at(new Date(deadline.getTime() + 12 * 60_000)), bot: true }),
    );

    const q = new FakeQueue();
    expect(await finalizeDueSubmissions({ ...deps(), queue: q })).toBeGreaterThanOrEqual(1);
    expect(await submission(s)).toMatchObject({ status: "submitted", final_sha: inGrace, late_days: 0 });
    const graded = (await runs(s)).filter((r) => r.trigger === "deadline");
    expect(graded).toMatchObject([{ sha: inGrace, status: "queued" }]);
    expect(q.sent).toContainEqual(expect.objectContaining({ name: "dispatch-run", data: { runId: graded[0]!.id } }));

    // The automatic run still waiting from before the cutoff is cancelled.
    expect((await runs(s)).filter((r) => r.trigger === "push")).toMatchObject([{ status: "cancelled" }]);

    // Nothing changes on the next sweep, and pushes after the cutoff don't start runs.
    await finalizeDueSubmissions(deps());
    await handlePush(deps(), pushEvent(s, sha()));
    expect((await runs(s)).filter((r) => r.trigger === "push")).toHaveLength(1);
    expect((await submission(s)).final_sha).toBe(inGrace);
  });

  it("accepts late work in the late window, counting started days", async () => {
    const deadline = new Date(Date.now() - 3 * 24 * HOUR);
    const s = await scenario({ dueAt: deadline, latePolicy: { per_day_percent: 10, max_days: 2, grace_minutes: 15 } });
    const late = sha();
    await handlePush(deps(), pushEvent(s, sha(), { pushedAt: at(new Date(deadline.getTime() - HOUR)) }));
    await handlePush(deps(), pushEvent(s, late, { pushedAt: at(new Date(deadline.getTime() + 30 * HOUR)) }));
    await finalizeDueSubmissions(deps());
    expect(await submission(s)).toMatchObject({ status: "submitted", final_sha: late, late_days: 2 });
  });

  it("marks work missing when nothing was pushed, and freezes the process score", async () => {
    const s = await scenario({ dueAt: new Date(Date.now() - 2 * HOUR), latePolicy: noLate });
    await db
      .insertInto("process_snapshots")
      .values({
        institution_id: s.institutionId,
        submission_id: s.submissionId,
        score: "0",
        breakdown: "{}",
        policy: "{}",
      })
      .execute();
    await finalizeDueSubmissions(deps());
    expect(await submission(s)).toMatchObject({ status: "missing", final_sha: null, late_days: null });
    expect(await runs(s)).toHaveLength(0);
    const snapshot = await db
      .selectFrom("process_snapshots")
      .select("is_final")
      .where("submission_id", "=", s.submissionId)
      .executeTakeFirstOrThrow();
    expect(snapshot.is_final).toBe(true);
  });

  it("waits for the student's extension and the late window", async () => {
    const extended = await scenario({
      dueAt: new Date(Date.now() - 2 * HOUR),
      latePolicy: noLate,
      extensionDueAt: new Date(Date.now() + 24 * HOUR),
    });
    const lateWindow = await scenario({
      dueAt: new Date(Date.now() - 2 * HOUR),
      latePolicy: { per_day_percent: 10, max_days: 1, grace_minutes: 0 },
    });
    await finalizeDueSubmissions(deps());
    expect((await submission(extended)).finalized_at).toBeNull();
    expect((await submission(lateWindow)).finalized_at).toBeNull();
  });
});

describe("after the cutoff", () => {
  it("lets only staff run tests, as re-grades of the graded commit", async () => {
    const deadline = new Date(Date.now() - 2 * HOUR);
    const s = await scenario({ dueAt: deadline, latePolicy: noLate });
    const head = sha();
    await handlePush(deps(), pushEvent(s, head, { pushedAt: at(new Date(deadline.getTime() - HOUR)) }));
    await finalizeDueSubmissions(deps());

    const app = await buildApp({ settings, db, queue: new FakeQueue(), verifier, graderAuth: tokenGraderAuth() });
    try {
      const start = (userId: string) =>
        app.inject({
          method: "POST",
          url: `/v1/submissions/${s.submissionId}/runs`,
          headers: { authorization: `Bearer ${verifier.tokenFor(userId)}` },
          payload: {},
        });
      const student = await start(s.student);
      expect(student.statusCode).toBe(409);
      expect(student.json().error).toBe("closed");
      const staff = await start(s.instructor);
      expect(staff.statusCode).toBe(201);
      const run = await db
        .selectFrom("evaluation_runs")
        .selectAll()
        .where("id", "=", staff.json().runId)
        .executeTakeFirstOrThrow();
      expect(run).toMatchObject({ trigger: "regrade", sha: head, requested_by: s.instructor });
    } finally {
      await app.close();
    }
  });

  it("retries graded runs that hit platform errors, up to three times", async () => {
    const deadline = new Date(Date.now() - 2 * HOUR);
    const s = await scenario({ dueAt: deadline, latePolicy: noLate });
    await handlePush(deps(), pushEvent(s, sha(), { pushedAt: at(new Date(deadline.getTime() - HOUR)) }));
    await finalizeDueSubmissions(deps());

    for (let attempt = 1; attempt <= 3; attempt++) {
      const [current] = (await runs(s)).filter((r) => r.status === "queued");
      await db
        .updateTable("evaluation_runs")
        .set({ status: "infra_error", finished_at: new Date() })
        .where("id", "=", current!.id)
        .execute();
      expect(await retryGradedRun(deps(), current!.id)).toBe(attempt < 3);
      expect(await retryGradedRun(deps(), current!.id)).toBe(false); // idempotent
    }
    expect((await runs(s)).filter((r) => r.trigger === "deadline").map((r) => r.status)).toEqual([
      "infra_error",
      "infra_error",
      "infra_error",
    ]);
  });

  it("retries a graded run the reaper gives up on", async () => {
    const deadline = new Date(Date.now() - 2 * HOUR);
    const s = await scenario({ dueAt: deadline, latePolicy: noLate });
    await handlePush(deps(), pushEvent(s, sha(), { pushedAt: at(new Date(deadline.getTime() - HOUR)) }));
    await finalizeDueSubmissions(deps());
    const [run] = (await runs(s)).filter((r) => r.trigger === "deadline");
    await db
      .updateTable("evaluation_runs")
      .set({ status: "dispatched", dispatched_at: new Date(Date.now() - 31 * 60_000) })
      .where("id", "=", run!.id)
      .execute();
    await reapRuns(deps());
    expect((await runs(s)).filter((r) => r.trigger === "deadline").map((r) => r.status)).toEqual([
      "infra_error",
      "queued",
    ]);
  });
});
