import { createHash } from "node:crypto";
import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { recomputeGrade, releaseGrades } from "../src/grading.ts";
import { generateGradeReport, REPORTS_BUCKET } from "../src/reports/index.ts";
import { pdfText } from "../src/reports/pdf.ts";
import { MemoryObjectStore } from "../src/storage.ts";
import { FakeQueue, Fixtures, testDb, testSettings } from "./helpers.ts";
import { createGradedScenario, type GradedScenario } from "./scenario.ts";

const db = testDb();
const fixtures = new Fixtures(db);
const settings = testSettings({ GRADER_CALLBACK_AUTH: "token" });
const log = Fastify({ logger: false }).log;

afterAll(async () => {
  await fixtures.cleanup();
  await db.destroy();
});

/** A graded submission with both rubric criteria scored and feedback written. */
async function reviewed(): Promise<GradedScenario> {
  const s = await createGradedScenario(db, fixtures, settings);
  await db
    .insertInto("rubric_scores")
    .values([
      {
        institution_id: s.institutionId,
        submission_id: s.submissionId,
        criterion_id: s.criteria[0],
        points: "9",
        comment: "Tidy",
      },
      {
        institution_id: s.institutionId,
        submission_id: s.submissionId,
        criterion_id: s.criteria[1],
        points: "7",
        comment: null,
      },
    ])
    .execute();
  await db
    .insertInto("feedback")
    .values({ institution_id: s.institutionId, submission_id: s.submissionId, body_md: "## Nice\n**Keep going.**" })
    .execute();
  await recomputeGrade(db, s.submissionId, { actorId: null });
  return s;
}

const reportsOf = (s: GradedScenario) =>
  db.selectFrom("grade_reports").selectAll().where("submission_id", "=", s.submissionId).orderBy("version").execute();

describe("grade reports", () => {
  it("are written for released grades only: canonical JSON with its hash, and a PDF", async () => {
    const s = await reviewed();
    const store = new MemoryObjectStore();
    const [current] = await db
      .selectFrom("grades")
      .select("id")
      .where("submission_id", "=", s.submissionId)
      .where("is_current", "=", true)
      .execute();
    expect(await generateGradeReport({ db, store, log }, current!.id)).toBe("skipped"); // not released

    const queue = new FakeQueue();
    await releaseGrades(db, s.assignmentId, { actorId: s.instructor, queue });
    expect(queue.sent.filter((j) => j.name === "grade-report")).toEqual([
      { name: "grade-report", data: { gradeId: current!.id }, options: { singletonKey: `report-${current!.id}` } },
    ]);
    expect(await generateGradeReport({ db, store, log }, current!.id)).toBe("created");
    expect(await generateGradeReport({ db, store, log }, current!.id)).toBe("exists");

    const [report] = await reportsOf(s);
    expect(report).toMatchObject({ version: 1, grade_version: 1, grade_id: current!.id });
    const json = (await store.get(REPORTS_BUCKET, report!.json_path))!.toString();
    expect(createHash("sha256").update(json).digest("hex")).toBe(report!.sha256);
    const data = JSON.parse(json);
    expect(data).toMatchObject({
      schema: "hbe.grade-report/1",
      report: { version: 1, grade_version: 1 },
      assignment: { title: "Todo", weights: { automated: 60, rubric: 25, process: 15 } },
      submission: { status: "graded", late_days: 0 },
      rubric: [
        { criterion: "Code quality", max_points: 10, points: 9, comment: "Tidy" },
        { criterion: "Docs", max_points: 10, points: 7, comment: null },
      ],
      feedback_md: "## Nice\n**Keep going.**",
      automated: { score: 70 },
      grade: { final: 74, complete: true, adjusted_by_staff: false },
    });
    expect(data.student.email).toMatch(/@test\.local$/);
    const pdf = (await store.get(REPORTS_BUCKET, report!.pdf_path))!;
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(createHash("sha256").update(pdf).digest("hex")).toBe(report!.pdf_sha256);
  });

  it("get a new version when a released grade changes, without the override's reason", async () => {
    const s = await reviewed();
    const store = new MemoryObjectStore();
    const queue = new FakeQueue();
    await releaseGrades(db, s.assignmentId, { actorId: s.instructor, queue });
    for (const job of queue.sent)
      await generateGradeReport({ db, store, log }, (job.data as { gradeId: string }).gradeId);

    queue.sent = [];
    const changed = await recomputeGrade(db, s.submissionId, {
      actorId: s.instructor,
      override: { score: 88, reason: "Private: excellent viva" },
      queue,
    });
    expect(queue.sent.filter((j) => j.name === "grade-report")).toEqual([
      { name: "grade-report", data: { gradeId: changed!.id }, options: { singletonKey: `report-${changed!.id}` } },
    ]);
    await generateGradeReport({ db, store, log }, changed!.id);

    const reports = await reportsOf(s);
    expect(reports.map((r) => r.version)).toEqual([1, 2]);
    const json = (await store.get(REPORTS_BUCKET, reports[1]!.json_path))!.toString();
    expect(JSON.parse(json).grade).toMatchObject({ final: 88, computed: 74, adjusted_by_staff: true });
    expect(json).not.toContain("excellent viva");
  });
});

describe("pdfText", () => {
  it("keeps what the standard PDF fonts can draw and replaces the rest", () => {
    expect(pdfText("Zoë – “quoted” · 5 × 2 − 1 ✓ 李")).toBe("Zoë – “quoted” · 5 × 2 - 1 v ?");
  });
});
