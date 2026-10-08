import { FakeGitHub } from "@hbe/github";
import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { recomputeGrade, releaseGrades } from "../src/grading.ts";
import { remindDeadlines } from "../src/notifications.ts";
import { scoreAndReport } from "../src/worker/evaluation.ts";
import { FakeQueue, Fixtures, testDb, testSettings } from "./helpers.ts";
import { createGradedScenario, createScenario, sha } from "./scenario.ts";

const db = testDb();
const fixtures = new Fixtures(db);
const settings = testSettings({ GRADER_CALLBACK_AUTH: "token" });
const log = Fastify({ logger: false }).log;
const HOUR = 3_600_000;

afterAll(async () => {
  await fixtures.cleanup();
  await db.destroy();
});

const inbox = (userId: string) =>
  db.selectFrom("notifications").selectAll().where("user_id", "=", userId).orderBy("created_at").execute();

describe("notifications", () => {
  it("remind students once per deadline when it is within a day", async () => {
    const soon = await createScenario(db, fixtures, { dueAt: new Date(Date.now() + 12 * HOUR) });
    const later = await createScenario(db, fixtures, { dueAt: new Date(Date.now() + 72 * HOUR) });
    await remindDeadlines(db);
    await remindDeadlines(db);
    expect(await inbox(soon.student)).toMatchObject([
      {
        type: "deadline_soon",
        title: "Todo is due within 24 hours",
        link: `/i/${soon.slug}/courses/${soon.courseId}/assignments/${soon.assignmentId}`,
      },
    ]);
    expect(await inbox(later.student)).toEqual([]);
  });

  it("tell students about runs they asked for, not every push", async () => {
    const s = await createScenario(db, fixtures);
    const run = async (trigger: "manual" | "push") => {
      const r = await db
        .insertInto("evaluation_runs")
        .values({
          institution_id: s.institutionId,
          submission_id: s.submissionId,
          sha: sha(),
          trigger,
          status: "completed",
          summary: JSON.stringify({ stages: [{ key: "api", status: "failed", duration_ms: 1 }] }),
          grader_suite_id: null,
          stack_profile_id: null,
          requested_by: trigger === "manual" ? s.student : null,
          callback_token_hash: null,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await db
        .insertInto("test_results")
        .values(
          (["passed", "failed"] as const).map((status, i) => ({
            institution_id: s.institutionId,
            run_id: r.id,
            stage: "api",
            test_key: `t${i}`,
            title: `Test ${i}`,
            status,
          })),
        )
        .execute();
      await scoreAndReport({ db, queue: new FakeQueue(), github: new FakeGitHub(), settings, log }, r.id);
      return r.id;
    };
    const asked = await run("manual");
    await run("push");
    expect(await inbox(s.student)).toMatchObject([
      {
        type: "run_finished",
        title: "Test results for Todo: 1/2 passed",
        link: `/i/${s.slug}/courses/${s.courseId}/assignments/${s.assignmentId}/submissions/${s.submissionId}/runs/${asked}`,
      },
    ]);
  });

  it("announce released grades, and updates to them", async () => {
    const s = await createGradedScenario(db, fixtures, settings);
    await db
      .insertInto("rubric_scores")
      .values(
        s.criteria.map((criterion_id) => ({
          institution_id: s.institutionId,
          submission_id: s.submissionId,
          criterion_id,
          points: "8",
        })),
      )
      .execute();
    await recomputeGrade(db, s.submissionId, { actorId: null });
    expect(await inbox(s.student)).toEqual([]); // nothing until release

    await releaseGrades(db, s.assignmentId, { actorId: s.instructor, queue: new FakeQueue() });
    await recomputeGrade(db, s.submissionId, {
      actorId: s.instructor,
      override: { score: 90, reason: "Viva" },
      queue: new FakeQueue(),
    });
    expect((await inbox(s.student)).map((n) => [n.type, n.title])).toEqual([
      ["grade_released", "Your grade for Todo is out"],
      ["grade_released", "Your grade for Todo was updated"],
    ]);
  });
});
