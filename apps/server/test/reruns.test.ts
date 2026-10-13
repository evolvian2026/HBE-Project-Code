import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { FakeQueue, FakeVerifier, Fixtures, randomGithubId, testDb, testSettings, unique } from "./helpers.ts";
import { createGradedScenario, createScenario, sha, type Scenario } from "./scenario.ts";

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

const post = (userId: string, url: string, payload: object = {}) =>
  app.inject({ method: "POST", url, headers: { authorization: `Bearer ${verifier.tokenFor(userId)}` }, payload });
const rerun = (s: Scenario, userId: string, payload: object = {}) =>
  post(userId, `/v1/assignments/${s.assignmentId}/reruns`, payload);
const runsOf = (s: Scenario) =>
  db
    .selectFrom("evaluation_runs as e")
    .innerJoin("submissions as sub", "sub.id", "e.submission_id")
    .select([
      "e.id",
      "e.submission_id",
      "e.sha",
      "e.trigger",
      "e.status",
      "e.requested_by",
      "e.batch_id",
      "e.grader_suite_id",
    ])
    .where("sub.assignment_id", "=", s.assignmentId)
    .orderBy("e.queued_at")
    .execute();

/** A second student of the scenario's course with their own repository at `head`. */
async function secondStudent(s: Scenario, head: string | null) {
  const repo = await db
    .insertInto("repositories")
    .values({
      institution_id: s.institutionId,
      github_installation_id: (
        await db
          .selectFrom("repositories")
          .select("github_installation_id")
          .where("id", "=", s.repositoryId)
          .executeTakeFirstOrThrow()
      ).github_installation_id,
      owner: s.owner,
      name: `todo-api-${unique()}`,
      github_repo_id: randomGithubId(),
      head_sha: head,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return db
    .insertInto("submissions")
    .values({
      institution_id: s.institutionId,
      assignment_id: s.assignmentId,
      user_id: s.otherStudent,
      repository_id: repo.id,
      status: "active",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
}

describe("bulk re-runs", () => {
  it("test every repository at its latest push, without using the students' daily runs", async () => {
    const s = await createScenario(db, fixtures, { quota: 1 });
    const head = sha();
    await db.updateTable("repositories").set({ head_sha: head }).where("id", "=", s.repositoryId).execute();
    const other = await secondStudent(s, null); // nothing pushed yet

    expect((await rerun(s, s.student)).statusCode).toBe(403);
    const res = await rerun(s, s.instructor);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ runs: 1, skipped: 1 });
    const { batchId } = res.json() as { batchId: string };
    const [run] = await runsOf(s);
    expect(run).toMatchObject({
      submission_id: s.submissionId,
      sha: head,
      trigger: "manual",
      status: "queued",
      requested_by: s.instructor,
      batch_id: batchId,
    });
    expect(
      await db.selectFrom("run_batches").selectAll().where("id", "=", batchId).executeTakeFirstOrThrow(),
    ).toMatchObject({ assignment_id: s.assignmentId, requested_by: s.instructor, scope: "all", runs: 1, skipped: 1 });
    expect(other.id).toBeTruthy();

    // The student still has their run for today.
    expect((await post(s.student, `/v1/submissions/${s.submissionId}/runs`)).statusCode).toBe(201);
    expect((await post(s.student, `/v1/submissions/${s.submissionId}/runs`)).json()).toMatchObject({
      error: "quota_exceeded",
    });

    // A run already queued for that commit isn't queued twice.
    expect((await rerun(s, s.instructor)).json()).toMatchObject({ runs: 0, skipped: 2 });

    // Once finished: "untested only" skips it, "every submission" runs it again.
    await db
      .updateTable("evaluation_runs")
      .set({ status: "completed" })
      .where("submission_id", "=", s.submissionId)
      .execute();
    expect((await rerun(s, s.instructor, { scope: "unfinished" })).json()).toMatchObject({ runs: 0, skipped: 2 });
    expect((await rerun(s, s.instructor, { scope: "all" })).json()).toMatchObject({ runs: 1, skipped: 1 });
  });

  it("re-grade finalized submissions at their graded commit, with another version of the suite", async () => {
    const s = await createGradedScenario(db, fixtures, settings);
    const final = (
      await db.selectFrom("submissions").select("final_sha").where("id", "=", s.submissionId).executeTakeFirstOrThrow()
    ).final_sha!;
    const v1 = (
      await db
        .selectFrom("assignments")
        .select("grader_suite_id")
        .where("id", "=", s.assignmentId)
        .executeTakeFirstOrThrow()
    ).grader_suite_id!;
    const base = await db.selectFrom("grader_suites").selectAll().where("id", "=", v1).executeTakeFirstOrThrow();
    const v2 = await db
      .insertInto("grader_suites")
      .values({ institution_id: s.institutionId, key: base.key, version: 99, title: base.title, path: base.path })
      .returning("id")
      .executeTakeFirstOrThrow();
    const other = await db
      .insertInto("grader_suites")
      .values({ institution_id: s.institutionId, key: `other-${unique()}`, version: 1, title: "Other", path: "x" })
      .returning("id")
      .executeTakeFirstOrThrow();

    expect((await rerun(s, s.ta)).statusCode).toBe(403); // instructors only: it costs runner minutes
    expect((await rerun(s, s.instructor, { suiteId: other.id })).statusCode).toBe(404);

    const res = await rerun(s, s.instructor, { suiteId: v2.id, useForAssignment: true });
    expect(res.json()).toMatchObject({ runs: 1, skipped: 0 });
    const runs = await runsOf(s);
    expect(runs.at(-1)).toMatchObject({ sha: final, trigger: "regrade", grader_suite_id: v2.id, status: "queued" });
    expect(
      (
        await db
          .selectFrom("assignments")
          .select("grader_suite_id")
          .where("id", "=", s.assignmentId)
          .executeTakeFirstOrThrow()
      ).grader_suite_id,
    ).toBe(v2.id);
    const audit = await db
      .selectFrom("audit_logs")
      .select(["action", "actor_id", "after"])
      .where("entity", "=", "assignments")
      .where("entity_id", "=", s.assignmentId)
      .orderBy("id", "desc")
      .executeTakeFirstOrThrow();
    expect(audit).toMatchObject({ actor_id: s.instructor, after: expect.objectContaining({ grader_suite_id: v2.id }) });
  });

  it("need an assignment with tests", async () => {
    const s = await createScenario(db, fixtures, { suite: false });
    expect((await rerun(s, s.instructor)).json()).toMatchObject({ error: "no_tests" });
  });
});
