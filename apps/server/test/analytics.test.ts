import { randomBytes } from "node:crypto";
import { sql } from "@hbe/db";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { FakeQueue, FakeVerifier, Fixtures, testDb, testSettings } from "./helpers.ts";
import { createScenario, type Scenario } from "./scenario.ts";

const db = testDb();
const fixtures = new Fixtures(db);
const verifier = new FakeVerifier();
let app: FastifyInstance;
let s: Scenario;

const DAY = 86_400_000;
const sha = () => randomBytes(20).toString("hex");

async function run(submissionId: string, finishedAt: Date, score: number, results: [string, string][]) {
  const [r] = (
    await sql<{ id: string }>`
      insert into evaluation_runs (institution_id, submission_id, sha, trigger, status, score, queued_at, started_at, finished_at)
      values (${s.institutionId}, ${submissionId}, ${sha()}, 'push', 'completed', ${score}, ${finishedAt}, ${finishedAt}, ${finishedAt})
      returning id`.execute(db)
  ).rows;
  for (const [key, status] of results) {
    await sql`insert into test_results (institution_id, run_id, stage, test_key, title, status)
              values (${s.institutionId}, ${r!.id}, 'api', ${key}, ${`Test ${key}`}, ${status})`.execute(db);
  }
}

beforeAll(async () => {
  app = await buildApp({ settings: testSettings(), db, queue: new FakeQueue(), verifier });
  s = await createScenario(db, fixtures);
  const now = Date.now();
  // Yesterday both tests failed; today one passes.
  await run(s.submissionId, new Date(now - DAY), 0, [
    ["todos.create", "failed"],
    ["todos.validate", "failed"],
  ]);
  await run(s.submissionId, new Date(now - 60_000), 50, [
    ["todos.create", "passed"],
    ["todos.validate", "error"],
  ]);
  // The other student's cutoff passed with nothing pushed.
  const assignment = await db
    .selectFrom("submissions")
    .select("assignment_id")
    .where("id", "=", s.submissionId)
    .executeTakeFirstOrThrow();
  await db
    .insertInto("submissions")
    .values({
      institution_id: s.institutionId,
      assignment_id: assignment.assignment_id,
      user_id: s.otherStudent,
      status: "missing",
      finalized_at: new Date(),
    })
    .execute();
});
afterAll(async () => {
  await app.close();
  await fixtures.cleanup();
  await db.destroy();
});

const get = (url: string, userId: string) =>
  app.inject({ method: "GET", url, headers: { authorization: `Bearer ${verifier.tokenFor(userId)}` } });

describe("assignment analytics", () => {
  it("is for course staff only", async () => {
    expect((await get(`/v1/assignments/${s.assignmentId}/analytics`, s.student)).statusCode).toBe(403);
  });

  it("shows how far students got, the most failed tests, and failures by day", async () => {
    const res = await get(`/v1/assignments/${s.assignmentId}/analytics`, s.instructor);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.summary).toMatchObject({ submissions: 2, tested: 1, medianTestScore: 50, missing: 1, graded: 0 });
    // On the latest run: validate errored (counted as failing), create passed.
    expect(body.tests).toEqual([
      { key: "todos.validate", title: "Test todos.validate", stage: "api", total: 1, failing: 1 },
      { key: "todos.create", title: "Test todos.create", stage: "api", total: 1, failing: 0 },
    ]);
    expect(body.heatmap.days.length).toBeGreaterThanOrEqual(2);
    const row = (key: string) => body.heatmap.rows.find((r: { key: string }) => r.key === key);
    const last = body.heatmap.days.length - 1;
    expect(row("todos.create").cells[last]).toEqual({ runs: 1, failed: 0 });
    expect(row("todos.create").cells[last - 1]).toEqual({ runs: 1, failed: 1 });
    expect(row("todos.validate").cells[last]).toEqual({ runs: 1, failed: 1 });
    expect(body.testScores[5]).toEqual({ from: 50, to: 60, count: 1 });
  });
});

describe("students who may need help", () => {
  it("lists them with their reasons, and leaves out those doing fine", async () => {
    expect((await get(`/v1/courses/${s.courseId}/at-risk`, s.student)).statusCode).toBe(403);
    const res = await get(`/v1/courses/${s.courseId}/at-risk`, s.instructor);
    expect(res.json().students).toEqual([
      {
        userId: s.otherStudent,
        name: expect.any(String),
        level: "medium",
        reasons: ["nothing submitted for 1 assignment (Todo)"],
      },
    ]);
  });
});

describe("cohort comparison", () => {
  it("compares terms of the same course, and withholds figures for small cohorts", async () => {
    // Last term's run of the course: five students with test scores 50 to 90.
    const course = await db
      .insertInto("courses")
      .values({ institution_id: s.institutionId, code: "c1", name: "Course", term: "Earlier" })
      .returning("id")
      .executeTakeFirstOrThrow();
    const profile = await db
      .selectFrom("stack_profiles")
      .select("id")
      .where("key", "=", "mern-node20")
      .executeTakeFirstOrThrow();
    const assignment = await db
      .insertInto("assignments")
      .values({
        institution_id: s.institutionId,
        course_id: course.id,
        slug: "todo-api",
        title: "Todo",
        stack_profile_id: profile.id,
        template_repo: "t/t",
        due_at: new Date(Date.now() - 100 * DAY),
        status: "published",
        published_at: new Date(Date.now() - 120 * DAY),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    for (const score of [50, 60, 70, 80, 90]) {
      const user = await fixtures.user();
      await db
        .insertInto("institution_memberships")
        .values({ institution_id: s.institutionId, user_id: user, role: "student" })
        .execute();
      const sub = await db
        .insertInto("submissions")
        .values({
          institution_id: s.institutionId,
          assignment_id: assignment.id,
          user_id: user,
          status: "graded",
          finalized_at: new Date(Date.now() - 100 * DAY),
          late_days: score === 50 ? 1 : 0,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      // In the course once the submission exists (joining a course creates missing ones).
      await db
        .insertInto("course_memberships")
        .values({ institution_id: s.institutionId, course_id: course.id, user_id: user, role: "student" })
        .execute();
      await run(sub.id, new Date(Date.now() - 101 * DAY), score, [["todos.create", score < 70 ? "failed" : "passed"]]);
    }

    const res = await get(`/v1/courses/${s.courseId}/cohorts`, s.instructor);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.terms.map((t: { term: string; current: boolean }) => [t.term, t.current])).toEqual([
      ["T", true],
      ["Earlier", false],
    ]);
    const todo = body.assignments.find((a: { slug: string }) => a.slug === "todo-api");
    const earlier = todo.terms.find((t: { term: string }) => t.term === "Earlier");
    expect(earlier).toMatchObject({
      submissions: 5,
      suppressed: false,
      medianTestScore: 70,
      onTimeRate: 0.8,
      missingRate: 0,
      mostFailed: [{ title: "Test todos.create", rate: 0.4 }],
    });
    // This term has two students: their figures stay hidden.
    expect(todo.terms.find((t: { term: string }) => t.term === "T")).toMatchObject({
      submissions: 2,
      suppressed: true,
      medianTestScore: null,
      mostFailed: [],
    });
  });
});
