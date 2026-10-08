import { FakeGitHub } from "@hbe/github";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { recomputeGrade } from "../src/grading.ts";
import { tokenGraderAuth } from "../src/grader-auth.ts";
import { handlePush } from "../src/worker/activity.ts";
import { finalizeDueSubmissions } from "../src/worker/deadlines.ts";
import { scoreAndReport } from "../src/worker/evaluation.ts";
import { FakeQueue, FakeVerifier, Fixtures, testDb, testSettings } from "./helpers.ts";
import { createScenario, pushEvent, sha, type Scenario } from "./scenario.ts";

const db = testDb();
const fixtures = new Fixtures(db);
const settings = testSettings({ GRADER_CALLBACK_AUTH: "token" });
const log = Fastify({ logger: false }).log;
const verifier = new FakeVerifier();
const HOUR = 3_600_000;
const deps = () => ({ db, queue: new FakeQueue(), settings, log });
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ settings, db, queue: new FakeQueue(), verifier, graderAuth: tokenGraderAuth() });
});
afterAll(async () => {
  await app.close();
  await fixtures.cleanup();
  await db.destroy();
});

interface Graded extends Scenario {
  ta: string;
  criteria: [string, string];
  runId: string | null;
}

/**
 * A finalized submission: two rubric criteria of 10 points, weights 60/25/15, a frozen process
 * score of 80, and (unless `pushed` is false) a completed deadline run scoring 70.
 */
async function graded({ pushed = true, lateDays = 0 } = {}): Promise<Graded> {
  const deadline = new Date(Date.now() - 2 * HOUR);
  const s = await createScenario(db, fixtures, {
    dueAt: deadline,
    latePolicy: { per_day_percent: 10, max_days: 0, grace_minutes: 15 },
    weights: { automated: 60, rubric: 25, process: 15 },
  });
  const criteria = await db
    .insertInto("assignment_criteria")
    .values([
      {
        institution_id: s.institutionId,
        assignment_id: s.assignmentId,
        title: "Code quality",
        max_points: "10",
        position: 0,
      },
      { institution_id: s.institutionId, assignment_id: s.assignmentId, title: "Docs", max_points: "10", position: 1 },
    ])
    .returning("id")
    .execute();
  const ta = await fixtures.user();
  await db
    .insertInto("institution_memberships")
    .values({ institution_id: s.institutionId, user_id: ta, role: "teacher", external_id: null })
    .execute();
  await db
    .insertInto("course_memberships")
    .values({ institution_id: s.institutionId, course_id: s.courseId, user_id: ta, role: "ta" })
    .execute();
  if (pushed) {
    await handlePush(deps(), pushEvent(s, sha(), { pushedAt: Math.floor((deadline.getTime() - HOUR) / 1000) }));
  }
  await finalizeDueSubmissions(deps());
  await db.updateTable("process_snapshots").set({ score: "80" }).where("submission_id", "=", s.submissionId).execute();
  if (lateDays) {
    await db.updateTable("submissions").set({ late_days: lateDays }).where("id", "=", s.submissionId).execute();
  }
  const run = await db
    .updateTable("evaluation_runs")
    .set({ status: "completed", score: "70", finished_at: new Date() })
    .where("submission_id", "=", s.submissionId)
    .where("trigger", "=", "deadline")
    .returning("id")
    .executeTakeFirst();
  return { ...s, ta, criteria: [criteria[0]!.id, criteria[1]!.id], runId: run?.id ?? null };
}

const as = (userId: string) => ({ authorization: `Bearer ${verifier.tokenFor(userId)}` });
const review = (s: Graded, userId: string, payload: object) =>
  app.inject({ method: "PUT", url: `/v1/submissions/${s.submissionId}/review`, headers: as(userId), payload });
const override = (s: Graded, userId: string, payload: object) =>
  app.inject({ method: "POST", url: `/v1/submissions/${s.submissionId}/override`, headers: as(userId), payload });
const release = (s: Graded, userId: string, payload: object = {}) =>
  app.inject({ method: "POST", url: `/v1/assignments/${s.assignmentId}/release`, headers: as(userId), payload });
const versions = (s: Scenario) =>
  db.selectFrom("grades").selectAll().where("submission_id", "=", s.submissionId).orderBy("version").execute();

describe("grading", () => {
  it("combines the graded run, rubric and process score, versioning every change", async () => {
    const s = await graded();
    const first = await recomputeGrade(db, s.submissionId, { actorId: null });
    expect(first).toMatchObject({ version: 1, complete: false, evaluation_run_id: s.runId });
    expect((first!.components as { pending: string[] }).pending).toEqual(["rubric scores for 2 criteria"]);

    // A TA scores the rubric and writes feedback.
    const res = await review(s, s.ta, {
      scores: [
        { criterionId: s.criteria[0], points: 10, comment: "Clean structure" },
        { criterionId: s.criteria[1], points: 6 },
      ],
      feedback: "## Well done\nAdd a README next time.",
    });
    expect(res.statusCode).toBe(200);
    // 0.6 × 70 + 0.25 × 80 + 0.15 × 80
    expect(res.json().grade).toMatchObject({ version: 2, complete: true, final_score: 74, computed_score: 74 });

    // Saving the same review changes nothing.
    await review(s, s.ta, { scores: [{ criterionId: s.criteria[0], points: 10, comment: "Clean structure" }] });
    expect(await versions(s)).toHaveLength(2);
    expect((await versions(s)).filter((v) => v.is_current).map((v) => v.version)).toEqual([2]);

    const feedback = await db
      .selectFrom("feedback")
      .selectAll()
      .where("submission_id", "=", s.submissionId)
      .executeTakeFirstOrThrow();
    expect(feedback).toMatchObject({ body_md: "## Well done\nAdd a README next time.", author_id: s.ta });
  });

  it("validates rubric scores and who may grade", async () => {
    const s = await graded();
    expect((await review(s, s.student, { scores: [] })).statusCode).toBe(403);
    const tooMany = await review(s, s.instructor, { scores: [{ criterionId: s.criteria[0], points: 11 }] });
    expect(tooMany.statusCode).toBe(400);
    expect(tooMany.json().message).toMatch(/At most 10/);
    const unknown = await review(s, s.instructor, { scores: [{ criterionId: s.submissionId, points: 1 }] });
    expect(unknown.json().error).toBe("unknown_criterion");
  });

  it("applies the late penalty to the grade earned", async () => {
    const s = await graded({ lateDays: 2 });
    const res = await review(s, s.instructor, {
      scores: [
        { criterionId: s.criteria[0], points: 10 },
        { criterionId: s.criteria[1], points: 6 },
      ],
    });
    expect(res.json().grade).toMatchObject({ late_days: 2, final_score: 59.2 }); // 74 less 20%
  });

  it("lets instructors override with a reason, and keeps it across recomputation", async () => {
    const s = await graded();
    await review(s, s.instructor, {
      scores: [
        { criterionId: s.criteria[0], points: 10 },
        { criterionId: s.criteria[1], points: 6 },
      ],
    });
    expect((await override(s, s.ta, { score: 90, reason: "Exceptional docs" })).statusCode).toBe(403);
    expect((await override(s, s.instructor, { score: 90 })).json().error).toBe("reason_required");
    const res = await override(s, s.instructor, { score: 90, reason: "Exceptional documentation" });
    expect(res.json().grade).toMatchObject({
      final_score: 90,
      computed_score: 74,
      override_reason: "Exceptional documentation",
    });

    // The rubric changes: the computed score moves, the override stays.
    const after = await review(s, s.instructor, { scores: [{ criterionId: s.criteria[1], points: 10 }] });
    expect(after.json().grade).toMatchObject({ final_score: 90, computed_score: 79 });

    const cleared = await override(s, s.instructor, { score: null });
    expect(cleared.json().grade).toMatchObject({ final_score: 79, override_score: null });
    expect((await versions(s)).map((v) => v.version)).toEqual([1, 2, 3, 4]);
  });

  it("releases complete grades only; later versions are released at once", async () => {
    const s = await graded();
    await recomputeGrade(db, s.submissionId, { actorId: null });
    expect((await release(s, s.ta)).statusCode).toBe(403);

    const early = await release(s, s.instructor);
    expect(early.json()).toEqual({
      released: 0,
      skipped: [
        { submissionId: s.submissionId, student: expect.any(String), pending: ["rubric scores for 2 criteria"] },
      ],
    });

    await review(s, s.instructor, {
      scores: [
        { criterionId: s.criteria[0], points: 8 },
        { criterionId: s.criteria[1], points: 8 },
      ],
    });
    expect((await release(s, s.instructor)).json()).toEqual({ released: 1, skipped: [] });
    const sub = await db
      .selectFrom("submissions")
      .select(["status", "grade_released_at"])
      .where("id", "=", s.submissionId)
      .executeTakeFirstOrThrow();
    expect(sub.status).toBe("graded");
    expect(sub.grade_released_at).not.toBeNull();
    const assignment = await db
      .selectFrom("assignments")
      .select("grades_released_at")
      .where("id", "=", s.assignmentId)
      .executeTakeFirstOrThrow();
    expect(assignment.grades_released_at).not.toBeNull();

    // A change after release is released with it.
    await override(s, s.instructor, { score: 95, reason: "Regrade request accepted" });
    const current = (await versions(s)).find((v) => v.is_current)!;
    expect(current.released_at).not.toBeNull();
  });

  it("grades missing work once the rubric is scored", async () => {
    const s = await graded({ pushed: false });
    const res = await review(s, s.instructor, {
      scores: [
        { criterionId: s.criteria[0], points: 0 },
        { criterionId: s.criteria[1], points: 0 },
      ],
    });
    // No tests (0) and no rubric points; the process score still counts.
    expect(res.json().grade).toMatchObject({ complete: true, final_score: 12 });
  });

  it("recomputes when the graded commit's run is scored", async () => {
    const s = await graded();
    const q = new FakeQueue();
    await db
      .updateTable("evaluation_runs")
      .set({ summary: JSON.stringify({ stages: [] }) })
      .where("id", "=", s.runId!)
      .execute();
    await scoreAndReport({ db, queue: q, github: new FakeGitHub(), settings, log }, s.runId!);
    expect(q.sent).toContainEqual({
      name: "compute-grade",
      data: { submissionId: s.submissionId },
      options: { singletonKey: `grade-${s.submissionId}` },
    });
  });
});
