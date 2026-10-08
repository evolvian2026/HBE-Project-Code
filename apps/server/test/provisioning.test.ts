import { FakeGitHub, GitHubError } from "@hbe/github";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { provisionSubmission, sweepProvisioning, type ProvisionDeps } from "../src/worker/provisioning.ts";
import { FakeQueue, FakeVerifier, Fixtures, randomGithubId, testDb, testSettings, unique } from "./helpers.ts";

const db = testDb();
const fixtures = new Fixtures(db);
const queue = new FakeQueue();
const verifier = new FakeVerifier();
let github: FakeGitHub;
let deps: ProvisionDeps;
let app: FastifyInstance;

let org: string;
let institution: { id: string };
let courseId: string;
let assignmentId: string;
let instructor: string;
const students: Record<string, { id: string; login: string | null }> = {};

beforeAll(async () => {
  app = await buildApp({ settings: testSettings(), db, queue, verifier });
  instructor = await fixtures.user();
  for (const name of ["ada", "grace", "linus", "nogh"]) {
    const login = name === "nogh" ? null : `${name}-${unique()}`;
    students[name] = {
      id: await fixtures.user(login ? { githubId: randomGithubId(), githubLogin: login } : {}),
      login,
    };
  }
  institution = await fixtures.institution([
    { userId: instructor, role: "teacher" },
    ...Object.values(students).map((s) => ({ userId: s.id, role: "student" as const })),
  ]);
  org = `org-${unique()}`;
  const installationId = randomGithubId();
  fixtures.installationIds.push(installationId);
  const gh = await db
    .insertInto("github_installations")
    .values({
      institution_id: institution.id,
      installation_id: installationId,
      account_id: 1,
      account_login: org,
      account_type: "Organization",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  courseId = (
    await db
      .insertInto("courses")
      .values({
        institution_id: institution.id,
        code: "CS1",
        name: "Course",
        term: "T1",
        github_installation_id: gh.id,
      })
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
  await db
    .insertInto("course_memberships")
    .values([
      { institution_id: institution.id, course_id: courseId, user_id: instructor, role: "instructor" },
      ...Object.values(students).map((s) => ({
        institution_id: institution.id,
        course_id: courseId,
        user_id: s.id,
        role: "student" as const,
      })),
    ])
    .execute();
  const profileId = (
    await db.selectFrom("stack_profiles").select("id").where("key", "=", "mern-node20").executeTakeFirstOrThrow()
  ).id;
  assignmentId = (
    await db
      .insertInto("assignments")
      .values({
        institution_id: institution.id,
        course_id: courseId,
        slug: "todo-api",
        title: "Todo API",
        stack_profile_id: profileId,
        template_repo: "hbe-templates/mern-starter",
        due_at: new Date(Date.now() + 7 * 86_400_000),
        weights: JSON.stringify({ automated: 85, rubric: 0, process: 15 }),
      })
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
});

beforeEach(() => {
  github = new FakeGitHub();
  github.templates.add("hbe-templates/mern-starter");
  deps = { db, github, queue, log: Fastify({ logger: false }).log };
  queue.sent = [];
});

afterAll(async () => {
  await app.close();
  await fixtures.cleanup();
  await db.destroy();
});

const as = (userId: string) => ({ authorization: `Bearer ${verifier.tokenFor(userId)}` });
const submissionOf = (name: string) =>
  db
    .selectFrom("submissions")
    .selectAll()
    .where("assignment_id", "=", assignmentId)
    .where("user_id", "=", students[name]!.id)
    .executeTakeFirstOrThrow();

describe("repository provisioning", () => {
  it("publishing queues one provisioning job per student with GitHub linked", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/assignments/${assignmentId}/publish`,
      headers: as(instructor),
    });
    expect(res.statusCode).toBe(200);
    expect(queue.sent.filter((s) => s.name === "provision-submission")).toHaveLength(3);
    expect((await submissionOf("nogh")).status).toBe("waiting_for_github");
  });

  it("creates the repository from the template, grants access, and is idempotent", async () => {
    const sub = await submissionOf("ada");
    expect(await provisionSubmission(deps, sub.id)).toBe("active");

    const name = `todo-api-${students.ada!.login}`;
    expect(github.repos.get(`${org}/${name}`.toLowerCase())?.template).toBe("hbe-templates/mern-starter");
    expect(github.collaborators.get(`${org}/${name}`.toLowerCase())?.get(students.ada!.login!)).toBe("push");

    const after = await submissionOf("ada");
    expect(after.status).toBe("active");
    const repo = await db
      .selectFrom("repositories")
      .selectAll()
      .where("id", "=", after.repository_id!)
      .executeTakeFirstOrThrow();
    expect(repo).toMatchObject({ owner: org, name, default_branch: "main", private: true });

    expect(await provisionSubmission(deps, sub.id)).toBe("skipped");
    expect(github.calls.filter((c) => c.startsWith("createRepoFromTemplate"))).toHaveLength(1);
  });

  it("adopts a repository created by an earlier attempt that crashed before recording it", async () => {
    const sub = await submissionOf("grace");
    const name = `todo-api-${students.grace!.login}`;
    github.repos.set(`${org}/${name}`.toLowerCase(), {
      id: 99,
      owner: org,
      name,
      defaultBranch: "main",
      private: true,
      installationId: 0,
      template: null,
    });
    expect(await provisionSubmission(deps, sub.id)).toBe("active");
    expect(github.calls.some((c) => c.startsWith("createRepoFromTemplate"))).toBe(false);
  });

  it("retries transient GitHub errors and records permanent ones", async () => {
    const sub = await submissionOf("linus");
    github.failures.push(new GitHubError(502, "GitHub returned 502", true));
    await expect(provisionSubmission(deps, sub.id)).rejects.toThrow("502");
    let row = await submissionOf("linus");
    expect(row).toMatchObject({ status: "provisioning", provisioning_attempts: 1 });
    expect(row.status_detail).toMatch(/^Retrying/);

    github.templates.clear(); // template deleted: permanent
    expect(await provisionSubmission(deps, sub.id)).toBe("failed");
    row = await submissionOf("linus");
    expect(row.status).toBe("provisioning_failed");
    expect(row.status_detail).toMatch(/Template hbe-templates\/mern-starter not found/);
  });

  it("lets staff retry a failed submission", async () => {
    const sub = await submissionOf("linus");
    const forbidden = await app.inject({
      method: "POST",
      url: `/v1/submissions/${sub.id}/retry-provisioning`,
      headers: as(students.ada!.id),
    });
    expect(forbidden.statusCode).toBe(403);
    const res = await app.inject({
      method: "POST",
      url: `/v1/submissions/${sub.id}/retry-provisioning`,
      headers: as(instructor),
    });
    expect(res.statusCode).toBe(200);
    expect((await submissionOf("linus")).status).toBe("provisioning");
    expect(queue.sent).toEqual([
      {
        name: "provision-submission",
        data: { submissionId: sub.id },
        options: { singletonKey: `provision-${sub.id}` },
      },
    ]);
    expect(await provisionSubmission(deps, sub.id)).toBe("active");
  });

  it("the sweep re-enqueues provisioning that has stalled", async () => {
    const sub = await submissionOf("nogh");
    await db.updateTable("submissions").set({ status: "provisioning" }).where("id", "=", sub.id).execute();
    await sweepProvisioning(deps); // just updated: not stale yet
    expect(queue.sent).toEqual([]);
    await new Promise((r) => setTimeout(r, 20));
    await sweepProvisioning(deps, { staleSeconds: 0 });
    expect(queue.sent.map((s) => s.data)).toContainEqual({ submissionId: sub.id });
    // Without a GitHub login it goes back to waiting.
    expect(await provisionSubmission(deps, sub.id)).toBe("waiting_for_github");
  });
});
