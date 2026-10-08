import { randomUUID } from "node:crypto";
import { FakeGitHub } from "@hbe/github";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeSubmissionProcess, fetchCommitDetails } from "../src/worker/activity.ts";
import { processGithubEvent } from "../src/worker/github-events.ts";
import { FakeQueue, Fixtures, randomGithubId, testDb, testSettings, unique } from "./helpers.ts";

const db = testDb();
const fixtures = new Fixtures(db);
const queue = new FakeQueue();
const github = new FakeGitHub();
const log = Fastify({ logger: false }).log;
const settings = testSettings();
const deps = { db, queue, github, log, settings };

const studentGithubId = randomGithubId();
const githubRepoId = randomGithubId();
const org = `org-${unique()}`;
const repoName = `todo-api-${unique()}`;
let student: string;
let submissionId: string;
let repositoryId: string;
// Deadline a week from now; activity spread over the previous days.
const deadline = new Date(Date.now() + 7 * 86_400_000);
const daysBefore = (n: number) => new Date(deadline.getTime() - n * 86_400_000).toISOString();
const sha = () => randomUUID().replace(/-/g, "").padEnd(40, "0").slice(0, 40);

async function deliver(event: string, payload: Record<string, unknown>) {
  const deliveryId = randomUUID();
  fixtures.deliveryIds.push(deliveryId);
  const row = await db
    .insertInto("github_events")
    .values({
      delivery_id: deliveryId,
      event,
      action: (payload.action as string) ?? null,
      installation_id: null,
      institution_id: null,
      repository_full_name: null,
      sender_id: null,
      payload: JSON.stringify(payload),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await processGithubEvent(deps, row.id);
}

const repository = () => ({ id: githubRepoId, full_name: `${org}/${repoName}` });

beforeAll(async () => {
  student = await fixtures.user({ githubId: studentGithubId, githubLogin: "ada" });
  const inst = await fixtures.institution([{ userId: student, role: "student" }]);
  const installationId = randomGithubId();
  fixtures.installationIds.push(installationId);
  const gh = await db
    .insertInto("github_installations")
    .values({
      institution_id: inst.id,
      installation_id: installationId,
      account_id: 1,
      account_login: org,
      account_type: "Organization",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const course = await db
    .insertInto("courses")
    .values({ institution_id: inst.id, code: "C1", name: "Course", term: "T", github_installation_id: gh.id })
    .returning("id")
    .executeTakeFirstOrThrow();
  await db
    .insertInto("course_memberships")
    .values({ institution_id: inst.id, course_id: course.id, user_id: student, role: "student" })
    .execute();
  const profile = await db
    .selectFrom("stack_profiles")
    .select("id")
    .where("key", "=", "mern-node20")
    .executeTakeFirstOrThrow();
  const assignment = await db
    .insertInto("assignments")
    .values({
      institution_id: inst.id,
      course_id: course.id,
      slug: "todo-api",
      title: "Todo",
      stack_profile_id: profile.id,
      template_repo: "t/t",
      due_at: deadline,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const repo = await db
    .insertInto("repositories")
    .values({
      institution_id: inst.id,
      github_installation_id: gh.id,
      owner: org,
      name: repoName,
      github_repo_id: githubRepoId,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  repositoryId = repo.id;
  submissionId = (
    await db
      .insertInto("submissions")
      .values({
        institution_id: inst.id,
        assignment_id: assignment.id,
        user_id: student,
        repository_id: repo.id,
        status: "active",
      })
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
});

afterAll(async () => {
  await fixtures.cleanup();
  await db.destroy();
});

describe("activity tracking", () => {
  const shas = {
    template: sha(),
    work1: sha(),
    work2: sha(),
    lockOnly: sha(),
    friend: sha(),
    merge: sha(),
    missing: sha(),
  };

  it("stores pushed commits and fetches their details", async () => {
    const at = (s: string, n: number, message: string) => ({
      id: s,
      message,
      timestamp: daysBefore(n),
      distinct: true,
      author: { username: "ada" },
    });
    await deliver("push", {
      ref: "refs/heads/main",
      repository: repository(),
      commits: [
        at(shas.template, 6, "Initial commit"),
        at(shas.work1, 5, "Add todo model"),
        at(shas.work2, 3, "Add routes"),
        at(shas.lockOnly, 3, "Update lockfile"),
        at(shas.friend, 2, "Help from a friend"),
        at(shas.merge, 2, "Merge branch 'feature'"),
        at(shas.missing, 2, "Force-pushed away"),
      ],
    });
    expect(queue.sent).toContainEqual({ name: "commit-details", data: { repositoryId } });
    expect(
      await db.selectFrom("commits").select("sha").where("repository_id", "=", repositoryId).execute(),
    ).toHaveLength(7);

    const set = (s: string, d: Partial<Parameters<typeof github.commits.set>[1]>) =>
      github.commits.set(`${org}/${repoName}@${s}`.toLowerCase(), {
        sha: s,
        authorId: studentGithubId,
        authorLogin: "ada",
        authorIsBot: false,
        parentCount: 1,
        additions: 0,
        deletions: 0,
        files: [],
        ...d,
      });
    set(shas.template, {
      authorId: 41898282,
      authorLogin: "github-actions[bot]",
      authorIsBot: true,
      files: [{ filename: "README.md", additions: 50, deletions: 0 }],
    });
    set(shas.work1, { files: [{ filename: "backend/src/todo.js", additions: 30, deletions: 2 }] });
    set(shas.work2, { files: [{ filename: "backend/src/routes.js", additions: 12, deletions: 0 }] });
    set(shas.lockOnly, { files: [{ filename: "backend/package-lock.json", additions: 800, deletions: 120 }] });
    set(shas.friend, {
      authorId: 123,
      authorLogin: "friend",
      files: [{ filename: "backend/src/x.js", additions: 40, deletions: 0 }],
    });
    set(shas.merge, { parentCount: 2, files: [{ filename: "backend/src/y.js", additions: 9, deletions: 0 }] });

    expect(await fetchCommitDetails(deps, repositoryId)).toBe(7);
    const rows = await db.selectFrom("commits").selectAll().where("repository_id", "=", repositoryId).execute();
    const bySha = Object.fromEntries(rows.map((r) => [r.sha, r]));
    expect(bySha[shas.work1]).toMatchObject({
      details_status: "done",
      author_profile_id: student,
      effective_lines: 32,
    });
    expect(bySha[shas.lockOnly]).toMatchObject({ effective_lines: 0 }); // lockfile ignored by the stack profile
    expect(bySha[shas.template]).toMatchObject({ is_bot: true, author_profile_id: null });
    expect(bySha[shas.friend]).toMatchObject({ author_profile_id: null, author_github_id: 123 });
    expect(bySha[shas.missing]).toMatchObject({ details_status: "unavailable" });
  });

  it("tracks pull requests, reviews and issues", async () => {
    const user = { id: studentGithubId, login: "ada" };
    await deliver("issues", {
      action: "opened",
      repository: repository(),
      issue: { id: 1, number: 1, title: "Login", state: "open", created_at: daysBefore(5), user },
    });
    await deliver("issues", {
      action: "closed",
      repository: repository(),
      issue: {
        id: 1,
        number: 1,
        title: "Login",
        state: "closed",
        created_at: daysBefore(5),
        closed_at: daysBefore(3),
        user,
      },
    });
    const pr = {
      id: 77,
      number: 2,
      title: "Add login",
      body: "Adds the login endpoint with tests.\n\nCloses #1",
      created_at: daysBefore(4),
      user,
    };
    await deliver("pull_request", {
      action: "opened",
      repository: repository(),
      pull_request: { ...pr, state: "open" },
    });
    await deliver("pull_request_review", {
      action: "submitted",
      repository: repository(),
      pull_request: { number: 2 },
      review: { id: 900, state: "APPROVED", submitted_at: daysBefore(3), user: { id: 555 } },
    });
    await deliver("pull_request", {
      action: "closed",
      repository: repository(),
      pull_request: { ...pr, state: "closed", merged_at: daysBefore(3), closed_at: daysBefore(3) },
    });

    const prRow = await db
      .selectFrom("pull_requests")
      .selectAll()
      .where("repository_id", "=", repositoryId)
      .executeTakeFirstOrThrow();
    expect(prRow).toMatchObject({
      number: 2,
      state: "merged",
      linked_issues: [1],
      review_count: 1,
      author_profile_id: student,
    });
    const issue = await db
      .selectFrom("issues")
      .selectAll()
      .where("repository_id", "=", repositoryId)
      .executeTakeFirstOrThrow();
    expect(issue).toMatchObject({ state: "closed", author_profile_id: student });
    expect(queue.sent).toContainEqual({
      name: "process-score",
      data: { submissionId },
      options: { singletonKey: `process-${submissionId}` },
    });
  });

  it("computes the process score with explanations", async () => {
    const score = await computeSubmissionProcess(deps, submissionId);
    const snap = await db
      .selectFrom("process_snapshots")
      .selectAll()
      .where("submission_id", "=", submissionId)
      .executeTakeFirstOrThrow();
    const breakdown = snap.breakdown as unknown as {
      meaningfulCommits: number;
      unattributedCommits: number;
      criteria: { key: string; earned: number; explanation: string }[];
    };
    expect(Number(snap.score)).toBe(score);
    expect(breakdown.meaningfulCommits).toBe(2); // work1 + work2 (not lockfile, bot, friend or merge)
    expect(breakdown.unattributedCommits).toBe(1); // the friend's commit
    expect(breakdown.criteria.find((c) => c.key === "active_days")?.explanation).toMatch(/Active on 2 of 6/);
    expect(breakdown.criteria.find((c) => c.key === "pr_workflow")?.explanation).toMatch(/1 of 3 merged pull requests/);
    expect(breakdown.criteria.find((c) => c.key === "issue_tracking")?.earned).toBeCloseTo(1 / 3, 5);
  });

  it("never overwrites a final snapshot", async () => {
    await db
      .updateTable("process_snapshots")
      .set({ is_final: true, score: "12.00" })
      .where("submission_id", "=", submissionId)
      .execute();
    expect(await computeSubmissionProcess(deps, submissionId)).toBeNull();
    const snap = await db
      .selectFrom("process_snapshots")
      .select("score")
      .where("submission_id", "=", submissionId)
      .executeTakeFirstOrThrow();
    expect(snap.score).toBe("12.00");
  });

  it("ignores pushes to repositories the platform does not track", async () => {
    await deliver("push", {
      ref: "refs/heads/main",
      repository: { id: 1, full_name: "x/y" },
      commits: [{ id: sha(), message: "m", timestamp: daysBefore(1) }],
    });
    expect(
      await db.selectFrom("commits").select("id").where("repository_id", "=", repositoryId).execute(),
    ).toHaveLength(7);
  });
});
