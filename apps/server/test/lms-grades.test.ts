import { CLAIM, toolJwks } from "@hbe/lms";
import { ROLES, TestPlatform, type ServedPlatform, type TestUser } from "@hbe/lms/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { recomputeGrade, releaseGrades } from "../src/grading.ts";
import { reconcileGrades, syncGrade, syncRoster } from "../src/lti/grades.ts";
import { toolKeys } from "../src/lti/keys.ts";
import type { SignInService } from "../src/lti/sign-in.ts";
import { FakeQueue, FakeVerifier, Fixtures, testDb, testSettings, unique } from "./helpers.ts";
import { createGradedScenario, type GradedScenario } from "./scenario.ts";

const db = testDb();
const fixtures = new Fixtures(db);
const settings = testSettings();
const verifier = new FakeVerifier();
const queue = new FakeQueue();
let app: FastifyInstance;
let lms: ServedPlatform;
let s: GradedScenario;
const CLIENT_ID = `client-${unique()}`;
const context = { id: `ctx-${unique()}`, title: "Web Development (Canvas)" };

const signIn: SignInService = {
  createUser: async (email) => fixtures.user({ email }),
  signInToken: async (email) => `hash-${email}`,
};
const as = (userId: string) => ({ authorization: `Bearer ${verifier.tokenFor(userId)}` });
const emailOf = async (userId: string) =>
  (await db.selectFrom("profiles").select("email").where("id", "=", userId).executeTakeFirstOrThrow()).email!;
const deps = () => ({ db, settings, queue });

beforeAll(async () => {
  lms = await TestPlatform.serve();
  lms.trustTool(toolJwks((await toolKeys(settings))!));
  app = await buildApp({ settings, db, queue, verifier, signIn });
  s = await createGradedScenario(db, fixtures, settings);
  await db
    .insertInto("lms_connections")
    .values({
      institution_id: s.institutionId,
      type: "canvas",
      name: "Canvas",
      issuer: lms.issuer,
      client_id: CLIENT_ID,
      auth_login_url: lms.authUrl,
      auth_token_url: lms.tokenUrl,
      jwks_url: lms.jwksUrl,
    })
    .execute();
});
afterAll(async () => {
  await app.close();
  await lms.close();
  await fixtures.cleanup();
  await db.destroy();
});

/** Login initiation and launch, as the browser would do them. */
async function launch(
  user: TestUser,
  opts: { messageType?: "LtiDeepLinkingRequest"; custom?: Record<string, string>; lineItem?: string } = {},
) {
  const login = await app.inject({
    method: "GET",
    url: `/lti/login?${new URLSearchParams({ iss: lms.issuer, login_hint: user.sub, target_link_uri: "https://x.test", client_id: CLIENT_ID })}`,
  });
  const auth = new URL(login.headers.location as string);
  const idToken = await lms.idToken({
    user,
    nonce: auth.searchParams.get("nonce")!,
    clientId: CLIENT_ID,
    deploymentId: "dep-1",
    context,
    services: true,
    ...opts,
  });
  return app.inject({
    method: "POST",
    url: "/lti/launch",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({ id_token: idToken, state: auth.searchParams.get("state")! }).toString(),
  });
}

/** Releases the scenario's grade (rubric scored first) and returns the released version's id. */
async function releaseGrade(): Promise<string> {
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
    .onConflict((oc) => oc.doNothing())
    .execute();
  await recomputeGrade(db, s.submissionId, { actorId: null });
  await releaseGrades(db, s.assignmentId, { actorId: s.instructor, queue });
  return (
    await db
      .selectFrom("grades")
      .select("id")
      .where("submission_id", "=", s.submissionId)
      .where("is_current", "=", true)
      .executeTakeFirstOrThrow()
  ).id;
}

describe("LTI deep linking", () => {
  it("lets an instructor pick assignments, links the LMS course, and answers the LMS", async () => {
    const instructor = { sub: `t-${unique()}`, email: await emailOf(s.instructor), roles: [ROLES.instructor] };
    const res = await launch(instructor, { messageType: "LtiDeepLinkingRequest" });
    expect(res.statusCode).toBe(303);
    const pickerUrl = res.headers.location as string;
    expect(pickerUrl).toMatch(/^\/lti\/deep-link\/[\w-]{40,}$/);

    const picker = await app.inject({ method: "GET", url: pickerUrl });
    expect(picker.statusCode).toBe(200);
    expect(picker.body).toContain(`value="${s.assignmentId}"`);
    expect(picker.body).toContain("linked to a course yet");

    const answer = await app.inject({
      method: "POST",
      url: pickerUrl,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ assignment: s.assignmentId }).toString(),
    });
    expect(answer.statusCode).toBe(200);
    const action = /action="([^"]+)"/.exec(answer.body)![1]!.replaceAll("&amp;", "&");
    expect(action).toBe(`${lms.issuer}/deep-link-return?context=${context.id}`);
    const jwt = /name="JWT" value="([^"]+)"/.exec(answer.body)![1]!;

    // The browser posts it to the LMS, which verifies it with the tool's keys.
    const posted = await fetch(action, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ JWT: jwt }),
    });
    expect(posted.status).toBe(200);
    expect(lms.deepLinkResponses.at(-1)).toMatchObject({
      iss: CLIENT_ID,
      [CLAIM.deepLinkingData]: "platform-data",
      [CLAIM.deepLinkingContentItems]: [
        {
          type: "ltiResourceLink",
          title: "Todo",
          url: `${settings.env.API_URL}/lti/launch`,
          custom: { assignment_id: s.assignmentId },
          lineItem: { scoreMaximum: 100, resourceId: s.assignmentId },
        },
      ],
    });

    const link = await db
      .selectFrom("lms_course_links")
      .select(["id", "course_id", "ags_lineitems_url", "nrps_url"])
      .where("context_id", "=", context.id)
      .executeTakeFirstOrThrow();
    expect(link).toMatchObject({
      course_id: s.courseId,
      ags_lineitems_url: lms.lineItemsUrl(context.id),
      nrps_url: lms.membershipsUrl(context.id),
    });
    expect(
      await db
        .selectFrom("lms_assignment_links")
        .select("assignment_id")
        .where("lms_course_link_id", "=", link.id)
        .execute(),
    ).toEqual([{ assignment_id: s.assignmentId }]);

    // The picker works once.
    const again = await app.inject({
      method: "POST",
      url: pickerUrl,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ assignment: s.assignmentId }).toString(),
    });
    expect(again.statusCode).toBe(400);
  });

  it("is for instructors only", async () => {
    const student = { sub: `s-${unique()}`, email: await emailOf(s.student), roles: [ROLES.learner] };
    const res = await launch(student, { messageType: "LtiDeepLinkingRequest" });
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain("Only instructors");
  });
});

describe("grade passback (AGS)", () => {
  const studentSub = `canvas-student-${unique()}`;
  let gradeId: string;
  let lineItemId: string;

  it("records the gradebook column of the link students open", async () => {
    // The LMS made the column when the link was added (its resourceId is the assignment).
    lineItemId = [...lms.lineItems.values()].find((i) => i.resourceId === s.assignmentId)!.id;
    const student = { sub: studentSub, email: await emailOf(s.student), roles: [ROLES.learner] };
    const res = await launch(student, { custom: { assignment_id: s.assignmentId }, lineItem: lineItemId });
    expect(res.statusCode).toBe(302);
    expect(new URL(res.headers.location as string).searchParams.get("next")).toBe(
      `/i/${s.slug}/courses/${s.courseId}/assignments/${s.assignmentId}`,
    );
    const column = await db
      .selectFrom("lms_assignment_links")
      .select(["lineitem_url", "resource_link_id"])
      .where("assignment_id", "=", s.assignmentId)
      .executeTakeFirstOrThrow();
    expect(column.lineitem_url).toBe(lineItemId);
    expect(column.resource_link_id).not.toBeNull();
  });

  it("sends a released grade once, and again only when asked", async () => {
    queue.sent.length = 0;
    gradeId = await releaseGrade();
    expect(queue.sent).toContainEqual(
      expect.objectContaining({ name: "lms-grade-sync", data: { gradeId, force: false } }),
    );
    const grade = await db
      .selectFrom("grades")
      .select("final_score")
      .where("id", "=", gradeId)
      .executeTakeFirstOrThrow();

    expect(await syncGrade(deps(), gradeId)).toEqual({ synced: 1, skipped: 0, failed: 0 });
    expect(lms.scores).toHaveLength(1);
    expect(lms.scores[0]).toMatchObject({
      lineItemId,
      score: {
        userId: studentSub,
        scoreGiven: Number(grade.final_score),
        scoreMaximum: 100,
        activityProgress: "Completed",
        gradingProgress: "FullyGraded",
      },
    });
    expect(String(lms.scores[0]!.score.comment)).toContain(`/assignments/${s.assignmentId}`);
    const row = await db
      .selectFrom("lms_grade_syncs")
      .select(["status", "lms_user_id", "attempts"])
      .where("grade_id", "=", gradeId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ status: "synced", lms_user_id: studentSub, attempts: 1 });

    await syncGrade(deps(), gradeId);
    expect(lms.scores).toHaveLength(1); // idempotent per version
    await syncGrade(deps(), gradeId, { force: true });
    expect(lms.scores).toHaveLength(2);
  });

  it("lets instructors (only) send an assignment's grades again", async () => {
    const url = `/v1/assignments/${s.assignmentId}/lms-sync`;
    expect((await app.inject({ method: "POST", url, headers: as(s.student), payload: {} })).statusCode).toBe(403);
    queue.sent.length = 0;
    const res = await app.inject({ method: "POST", url, headers: as(s.instructor), payload: {} });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ queued: 1 });
    expect(queue.sent).toEqual([expect.objectContaining({ name: "lms-grade-sync", data: { gradeId, force: true } })]);
  });

  it("flags grades changed in the LMS instead of overwriting them", async () => {
    lms.setResult(lineItemId, studentSub, 55);
    const summary = await reconcileGrades(deps());
    expect(summary).toMatchObject({ conflicts: 1 });
    const row = await db
      .selectFrom("lms_grade_syncs")
      .select(["status", "lms_score", "last_error"])
      .where("grade_id", "=", gradeId)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: "conflict", lms_score: "55.00" });

    // A normal sync leaves it alone; a teacher's "send again" overwrites it.
    const before = lms.scores.length;
    await syncGrade(deps(), gradeId);
    expect(lms.scores).toHaveLength(before);
    await syncGrade(deps(), gradeId, { force: true });
    expect(lms.scores).toHaveLength(before + 1);
    expect(
      (
        await db
          .selectFrom("lms_grade_syncs")
          .select("status")
          .where("grade_id", "=", gradeId)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe("synced");
  });
});

describe("roster sync (NRPS) and gradebook columns the tool makes", () => {
  it("matches the roster by email and adds learners to the course", async () => {
    // A second student: a member of the institution who never opened the platform from the LMS.
    const newcomer = await fixtures.user();
    await db
      .insertInto("institution_memberships")
      .values({ institution_id: s.institutionId, user_id: newcomer, role: "student", external_id: null })
      .execute();
    const stranger = `nobody-${unique()}@test.local`;
    lms.setMembers([
      { user_id: "nrps-newcomer", email: await emailOf(newcomer), roles: [ROLES.learner] },
      { user_id: "nrps-stranger", email: stranger, roles: [ROLES.learner] },
      { user_id: "nrps-teacher", email: await emailOf(s.instructor), roles: [ROLES.instructor] },
      { user_id: "nrps-gone", email: "gone@test.local", roles: [ROLES.learner], status: "Inactive" },
    ]);
    const link = await db
      .selectFrom("lms_course_links")
      .select("id")
      .where("context_id", "=", context.id)
      .executeTakeFirstOrThrow();

    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/lms-course-links/${link.id}/roster-sync`,
          headers: as(s.student),
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    const queued = await app.inject({
      method: "POST",
      url: `/v1/lms-course-links/${link.id}/roster-sync`,
      headers: as(s.instructor),
      payload: {},
    });
    expect(queued.statusCode).toBe(202);

    const summary = await syncRoster(deps(), link.id);
    expect(summary).toEqual({ members: 3, linked: 2, waiting: 1, added: 1, inactive: 1 });
    const joined = await db
      .selectFrom("course_memberships")
      .select(["role", "source"])
      .where("course_id", "=", s.courseId)
      .where("user_id", "=", newcomer)
      .executeTakeFirstOrThrow();
    expect(joined).toEqual({ role: "student", source: "lms" });
    const waiting = await db
      .selectFrom("lms_user_links")
      .select(["status", "email"])
      .where("lms_user_id", "=", "nrps-stranger")
      .executeTakeFirstOrThrow();
    expect(waiting).toEqual({ status: "pending", email: stranger });
    const stored = await db
      .selectFrom("lms_course_links")
      .select(["roster_synced_at", "roster_summary"])
      .where("id", "=", link.id)
      .executeTakeFirstOrThrow();
    expect(stored.roster_synced_at).not.toBeNull();
    expect(stored.roster_summary).toMatchObject({ added: 1 });
  });

  it("creates the gradebook column itself when the LMS hasn't got one", async () => {
    const other = await createGradedScenario(db, fixtures, settings);
    const otherCtx = `ctx-${unique()}`;
    const conn = await db
      .insertInto("lms_connections")
      .values({
        institution_id: other.institutionId,
        type: "moodle",
        name: "Moodle",
        issuer: lms.issuer,
        client_id: `client-${unique()}`,
        auth_login_url: lms.authUrl,
        auth_token_url: lms.tokenUrl,
        jwks_url: lms.jwksUrl,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await db
      .insertInto("lms_course_links")
      .values({
        institution_id: other.institutionId,
        lms_connection_id: conn.id,
        context_id: otherCtx,
        course_id: other.courseId,
        ags_lineitems_url: lms.lineItemsUrl(otherCtx),
      })
      .execute();
    await db
      .insertInto("lms_user_links")
      .values({
        institution_id: other.institutionId,
        lms_connection_id: conn.id,
        lms_user_id: "moodle-student",
        profile_id: other.student,
        status: "linked",
        matched_by: "email",
      })
      .execute();
    s = other;
    const gradeId = await releaseGrade();
    expect(await syncGrade(deps(), gradeId)).toEqual({ synced: 1, skipped: 0, failed: 0 });
    const made = [...lms.lineItems.values()].find((i) => i.id.startsWith(lms.lineItemsUrl(otherCtx)));
    expect(made).toMatchObject({ label: "Todo", scoreMaximum: 100, resourceId: other.assignmentId, tag: "hbe-grade" });
    expect(lms.scores.at(-1)).toMatchObject({ lineItemId: made!.id, score: { userId: "moodle-student" } });
  });
});
