import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { FakeQueue, FakeVerifier, Fixtures, randomGithubId, testDb, testSettings, unique } from "./helpers.ts";

const db = testDb();
const fixtures = new Fixtures(db);
const verifier = new FakeVerifier();
let app: FastifyInstance;

let instructor: string;
let otherTeacher: string;
let studentWithGithub: string;
let studentWithoutGithub: string;
let institution: { id: string };
let courseId: string;
let profileId: string;

beforeAll(async () => {
  app = await buildApp({ settings: testSettings(), db, queue: new FakeQueue(), verifier });
  instructor = await fixtures.user();
  otherTeacher = await fixtures.user();
  studentWithGithub = await fixtures.user({ githubId: randomGithubId() });
  studentWithoutGithub = await fixtures.user();
  institution = await fixtures.institution([
    { userId: instructor, role: "teacher" },
    { userId: otherTeacher, role: "teacher" },
    { userId: studentWithGithub, role: "student" },
    { userId: studentWithoutGithub, role: "student" },
  ]);
  const installationId = randomGithubId();
  fixtures.installationIds.push(installationId);
  const installation = await db
    .insertInto("github_installations")
    .values({
      institution_id: institution.id,
      installation_id: installationId,
      account_id: 1,
      account_login: `org-${unique()}`,
      account_type: "Organization",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const course = await db
    .insertInto("courses")
    .values({
      institution_id: institution.id,
      code: "CS101",
      name: "Web Dev",
      term: "2026-T1",
      github_installation_id: installation.id,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  courseId = course.id;
  await db
    .insertInto("course_memberships")
    .values([
      { institution_id: institution.id, course_id: courseId, user_id: instructor, role: "instructor" },
      { institution_id: institution.id, course_id: courseId, user_id: studentWithGithub, role: "student" },
      { institution_id: institution.id, course_id: courseId, user_id: studentWithoutGithub, role: "student" },
    ])
    .execute();
  profileId = (
    await db.selectFrom("stack_profiles").select("id").where("key", "=", "mern-node20").executeTakeFirstOrThrow()
  ).id;
});

afterAll(async () => {
  await app.close();
  await fixtures.cleanup();
  await db.destroy();
});

const as = (userId: string) => ({ authorization: `Bearer ${verifier.tokenFor(userId)}` });

async function draft(overrides: Record<string, unknown> = {}): Promise<string> {
  const row = await db
    .insertInto("assignments")
    .values({
      institution_id: institution.id,
      course_id: courseId,
      slug: `a-${unique()}`,
      title: "Todo API",
      stack_profile_id: profileId,
      template_repo: "hbe-templates/mern-starter",
      due_at: new Date(Date.now() + 14 * 86_400_000),
      weights: JSON.stringify({ automated: 85, rubric: 0, process: 15 }),
      ...overrides,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

describe("POST /v1/assignments/:id/publish", () => {
  it("only lets the course's instructors (or admins) publish", async () => {
    const id = await draft();
    const res = await app.inject({ method: "POST", url: `/v1/assignments/${id}/publish`, headers: as(otherTeacher) });
    expect(res.statusCode).toBe(403);
  });

  it("explains what is missing", async () => {
    const id = await draft({
      template_repo: null,
      weights: JSON.stringify({ automated: 60, rubric: 25, process: 15 }),
    });
    const res = await app.inject({ method: "POST", url: `/v1/assignments/${id}/publish`, headers: as(instructor) });
    expect(res.statusCode).toBe(422);
    expect(res.json().problems).toEqual([
      "Set the template repository students start from.",
      "Add rubric criteria, or set the rubric weight to 0.",
    ]);
  });

  it("publishes and creates a submission per student", async () => {
    const id = await draft();
    const res = await app.inject({ method: "POST", url: `/v1/assignments/${id}/publish`, headers: as(instructor) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ published: true, submissionsCreated: 2 });

    const subs = await db
      .selectFrom("submissions")
      .select(["user_id", "status"])
      .where("assignment_id", "=", id)
      .execute();
    expect(Object.fromEntries(subs.map((s) => [s.user_id, s.status]))).toEqual({
      [studentWithGithub]: "provisioning",
      [studentWithoutGithub]: "waiting_for_github",
    });

    const again = await app.inject({ method: "POST", url: `/v1/assignments/${id}/publish`, headers: as(instructor) });
    expect(again.statusCode).toBe(422);
  });
});
