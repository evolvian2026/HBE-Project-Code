import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { FakeQueue, FakeVerifier, Fixtures, testDb, testSettings } from "./helpers.ts";
import { createScenario, type Scenario } from "./scenario.ts";

const db = testDb();
const fixtures = new Fixtures(db);
const verifier = new FakeVerifier();
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ settings: testSettings(), db, queue: new FakeQueue(), verifier });
});
afterAll(async () => {
  await app.close();
  await fixtures.cleanup();
  await db.destroy();
});

const post = (userId: string, url: string, payload: object) =>
  app.inject({ method: "POST", url, headers: { authorization: `Bearer ${verifier.tokenFor(userId)}` }, payload });
const ask = (s: Scenario, userId: string, message = "The search tests failed because of a typo in the spec.") =>
  post(userId, `/v1/submissions/${s.submissionId}/regrade-requests`, { message });
const released = (s: Scenario, at = new Date()) =>
  db.updateTable("submissions").set({ grade_released_at: at }).where("id", "=", s.submissionId).execute();
const notificationsOf = (userId: string) =>
  db.selectFrom("notifications").selectAll().where("user_id", "=", userId).orderBy("created_at").execute();

describe("regrade requests", () => {
  it("are for the student's released grade, one open at a time, and tell the course staff", async () => {
    const s = await createScenario(db, fixtures);
    expect((await ask(s, s.student)).json()).toMatchObject({ error: "not_released" });
    await released(s);
    expect((await ask(s, s.otherStudent)).statusCode).toBe(403);
    expect((await ask(s, s.instructor)).statusCode).toBe(403);
    expect((await ask(s, s.student, "Too short")).statusCode).toBe(400);

    const res = await ask(s, s.student);
    expect(res.statusCode).toBe(201);
    expect(res.json().request).toMatchObject({ status: "open" });
    expect((await ask(s, s.student)).json()).toMatchObject({ error: "already_open" });

    const [n] = await notificationsOf(s.instructor);
    expect(n).toMatchObject({
      type: "regrade_requested",
      body: "The search tests failed because of a typo in the spec.",
      link: `/i/${s.slug}/courses/${s.courseId}/assignments/${s.assignmentId}/submissions/${s.submissionId}`,
    });
    expect(n!.title).toMatch(/asked for a regrade of /);
  });

  it("are answered by course staff, which tells the student", async () => {
    const s = await createScenario(db, fixtures);
    await released(s);
    const id = (await ask(s, s.student)).json().request.id as string;
    const resolve = (userId: string, payload: object) => post(userId, `/v1/regrade-requests/${id}/resolve`, payload);

    expect((await resolve(s.student, { outcome: "accepted", response: "Accepting my own request" })).statusCode).toBe(
      403,
    );
    expect((await resolve(s.instructor, { outcome: "accepted", response: "ok" })).statusCode).toBe(400);
    const res = await resolve(s.instructor, {
      outcome: "accepted",
      response: "You're right: the spec had a typo. I've adjusted the rubric.",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().request).toMatchObject({ status: "accepted" });
    const row = await db.selectFrom("regrade_requests").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ resolved_by: s.instructor, requested_by: s.student });
    expect((await resolve(s.instructor, { outcome: "declined", response: "Changed my mind" })).json()).toMatchObject({
      error: "not_open",
    });

    const [n] = await notificationsOf(s.student);
    expect(n).toMatchObject({
      type: "regrade_answered",
      title: expect.stringMatching(/was accepted$/),
      body: "You're right: the spec had a typo. I've adjusted the rubric.",
      link: `/i/${s.slug}/courses/${s.courseId}/assignments/${s.assignmentId}`,
    });

    // Once answered, the student may ask again (within the window).
    expect((await ask(s, s.student)).statusCode).toBe(201);
  });

  it("can be withdrawn by the student who asked", async () => {
    const s = await createScenario(db, fixtures);
    await released(s);
    const id = (await ask(s, s.student)).json().request.id as string;
    expect((await post(s.instructor, `/v1/regrade-requests/${id}/withdraw`, {})).statusCode).toBe(403);
    expect((await post(s.student, `/v1/regrade-requests/${id}/withdraw`, {})).json().request).toMatchObject({
      status: "withdrawn",
    });
    expect((await post(s.student, `/v1/regrade-requests/${id}/withdraw`, {})).statusCode).toBe(409);
  });

  it("close after the assignment's regrade window", async () => {
    const s = await createScenario(db, fixtures);
    await released(s, new Date(Date.now() - 8 * 86_400_000));
    expect((await ask(s, s.student)).json()).toMatchObject({ error: "regrade_window_closed" });
    await db.updateTable("assignments").set({ regrade_window_days: 10 }).where("id", "=", s.assignmentId).execute();
    expect((await ask(s, s.student)).statusCode).toBe(201);
    await db.updateTable("assignments").set({ regrade_window_days: 0 }).where("id", "=", s.assignmentId).execute();
    await db.deleteFrom("regrade_requests").where("submission_id", "=", s.submissionId).execute();
    expect((await ask(s, s.student)).json()).toMatchObject({ error: "regrades_closed" });
  });
});
