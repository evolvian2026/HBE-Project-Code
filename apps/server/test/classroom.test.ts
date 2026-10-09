import { FakeGoogle } from "@hbe/lms/google-testing";
import type { Settings } from "@hbe/settings";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { recomputeGrade, releaseGrades } from "../src/grading.ts";
import { reconcileGrades, syncGrade, syncRoster } from "../src/lti/grades.ts";
import { openSecret } from "../src/secrets.ts";
import { FakeQueue, FakeVerifier, Fixtures, testDb, testSettings, unique } from "./helpers.ts";
import { createGradedScenario, type GradedScenario } from "./scenario.ts";

const db = testDb();
const fixtures = new Fixtures(db);
const verifier = new FakeVerifier();
const queue = new FakeQueue();
let google: FakeGoogle;
let settings: Settings;
let app: FastifyInstance;
let s: GradedScenario;
let admin: string;
const classId = `class-${unique()}`;

const as = (userId: string) => ({ authorization: `Bearer ${verifier.tokenFor(userId)}` });
const emailOf = async (userId: string) =>
  (await db.selectFrom("profiles").select("email").where("id", "=", userId).executeTakeFirstOrThrow()).email!;
const deps = () => ({ db, settings, queue });

beforeAll(async () => {
  google = await FakeGoogle.serve();
  settings = testSettings({
    GOOGLE_OAUTH_CLIENT_ID: google.clientId,
    GOOGLE_OAUTH_CLIENT_SECRET: google.clientSecret,
    GOOGLE_FAKE_URL: google.url,
  });
  app = await buildApp({ settings, db, queue, verifier });
  s = await createGradedScenario(db, fixtures, settings);
  admin = await fixtures.user();
  await db
    .insertInto("institution_memberships")
    .values({ institution_id: s.institutionId, user_id: admin, role: "admin", external_id: null })
    .execute();
});
afterAll(async () => {
  await app.close();
  await google.close();
  await fixtures.cleanup();
  await db.destroy();
});

describe("Google Classroom", () => {
  let linkId: string;

  it("is turned on by an admin, then teachers connect their Google account", async () => {
    const connect = () =>
      app.inject({
        method: "POST",
        url: `/v1/institutions/${s.institutionId}/google/connect`,
        headers: as(s.instructor),
        payload: { next: `/i/${s.slug}/courses/${s.courseId}` },
      });
    expect((await connect()).statusCode).toBe(409); // not turned on yet
    const toggle = (userId: string) =>
      app.inject({
        method: "PUT",
        url: `/v1/institutions/${s.institutionId}/google-classroom`,
        headers: as(userId),
        payload: { enabled: true },
      });
    expect((await toggle(s.instructor)).statusCode).toBe(403);
    expect((await toggle(admin)).statusCode).toBe(200);
    expect((await connect()).statusCode).toBe(201);

    // The teacher consents at Google, which sends the browser back with a code.
    const teacherEmail = await emailOf(s.instructor);
    google.signInAs = { sub: "g-teacher", email: teacherEmail };
    const consent = await fetch((await connect()).json().url, { redirect: "manual" });
    const callback = new URL(consent.headers.get("location")!);
    expect(callback.pathname).toBe("/v1/oauth/google/callback");
    const res = await app.inject({ method: "GET", url: `${callback.pathname}${callback.search}` });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${settings.env.APP_URL}/i/${s.slug}/courses/${s.courseId}?google=connected`);

    const account = await db
      .selectFrom("google_accounts")
      .selectAll()
      .where("profile_id", "=", s.instructor)
      .executeTakeFirstOrThrow();
    expect(account).toMatchObject({ google_user_id: "g-teacher", email: teacherEmail.toLowerCase(), revoked_at: null });
    // Only the encrypted token is stored.
    expect(account.refresh_token_encrypted).not.toContain("refresh-");
    expect(openSecret(settings, account.refresh_token_encrypted)).toMatch(/^refresh-/);

    // The state works once.
    const replay = await app.inject({ method: "GET", url: `${callback.pathname}${callback.search}` });
    expect(new URL(replay.headers.location as string).searchParams.get("google_error")).toMatch(/expired/);
  });

  it("links one of the teacher's classes to the course and reads its roster", async () => {
    const studentEmail = await emailOf(s.student);
    google.addClass({
      id: classId,
      name: "Web Development",
      section: "Period 2",
      teacherSub: "g-teacher",
      students: [
        { userId: "g-student", email: studentEmail, name: "Student" },
        { userId: "g-stranger", email: `stranger-${unique()}@test.local` },
        { userId: "g-other", email: await emailOf(s.otherStudent) },
      ],
    });
    google.addClass({ id: `not-mine-${unique()}`, name: "Someone else's", teacherSub: "g-someone" });

    const list = await app.inject({
      method: "GET",
      url: `/v1/courses/${s.courseId}/classroom-classes`,
      headers: as(s.instructor),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().classes).toEqual([
      expect.objectContaining({ id: classId, name: "Web Development", linkedCourseId: null }),
    ]);

    const link = (payload: Record<string, string>, userId = s.instructor) =>
      app.inject({ method: "POST", url: `/v1/courses/${s.courseId}/classroom-links`, headers: as(userId), payload });
    expect((await link({ classId: "not-mine" })).statusCode).toBe(403);
    expect((await link({ classId }, s.student)).statusCode).toBe(403);
    queue.sent.length = 0;
    const linked = await link({ classId });
    expect(linked.statusCode).toBe(201);
    linkId = linked.json().id;
    expect(queue.sent).toEqual([expect.objectContaining({ name: "lms-roster-sync", data: { courseLinkId: linkId } })]);

    expect(await syncRoster(deps(), linkId)).toEqual({ members: 3, linked: 2, waiting: 1, added: 0, inactive: 0 });
    const links = await db
      .selectFrom("lms_user_links")
      .select(["lms_user_id", "status"])
      .where("lms_user_id", "in", ["g-student", "g-stranger"])
      .orderBy("lms_user_id")
      .execute();
    expect(links).toEqual([
      { lms_user_id: "g-stranger", status: "pending" },
      { lms_user_id: "g-student", status: "linked" },
    ]);
  });

  it("posts the assignment as coursework and sends released grades to it", async () => {
    const post = (userId: string) =>
      app.inject({
        method: "POST",
        url: `/v1/assignments/${s.assignmentId}/classroom-coursework`,
        headers: as(userId),
        payload: {},
      });
    expect((await post(s.student)).statusCode).toBe(403);
    const posted = await post(s.instructor);
    expect(posted.json()).toEqual({ posted: 1, already: 0, failed: [] });
    expect((await post(s.instructor)).json()).toEqual({ posted: 0, already: 1, failed: [] });
    const work = [...google.courseWork.values()].find((w) => w.courseId === classId)!;
    expect(work).toMatchObject({ title: "Todo", maxPoints: 100 });
    expect(work.description).toContain(`/assignments/${s.assignmentId}`);

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
    await releaseGrades(db, s.assignmentId, { actorId: s.instructor, queue });
    const grade = await db
      .selectFrom("grades")
      .select(["id", "final_score"])
      .where("submission_id", "=", s.submissionId)
      .where("is_current", "=", true)
      .executeTakeFirstOrThrow();

    expect(await syncGrade(deps(), grade.id)).toEqual({ synced: 1, skipped: 0, failed: 0 });
    const submission = [...google.submissions.values()].find(
      (x) => x.courseWorkId === work.id && x.userId === "g-student",
    )!;
    expect(submission).toMatchObject({ assignedGrade: Number(grade.final_score), state: "RETURNED" });

    // A grade changed in Classroom is flagged, not overwritten.
    submission.assignedGrade = 12;
    expect(await reconcileGrades(deps())).toMatchObject({ conflicts: 1 });
    const row = await db
      .selectFrom("lms_grade_syncs")
      .select(["status", "lms_score"])
      .where("grade_id", "=", grade.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ status: "conflict", lms_score: "12.00" });

    // When the teacher revokes access, sends fail and the account asks to reconnect.
    google.revoke("g-teacher");
    await expect(syncGrade(deps(), grade.id, { force: true })).rejects.toThrow(
      /no longer connected|expired or was revoked/,
    );
    const account = await db
      .selectFrom("google_accounts")
      .select(["revoked_at", "last_error"])
      .where("profile_id", "=", s.instructor)
      .executeTakeFirstOrThrow();
    expect(account.revoked_at).not.toBeNull();
    const failed = await db
      .selectFrom("lms_grade_syncs")
      .select(["status", "last_error"])
      .where("grade_id", "=", grade.id)
      .executeTakeFirstOrThrow();
    expect(failed.status).toBe("failed");
  });
});
