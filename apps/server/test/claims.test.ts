import type { ProcessResult } from "@hbe/core";
import { FakeGitHub } from "@hbe/github";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { computeSubmissionProcess, fetchCommitDetails, handlePush } from "../src/worker/activity.ts";
import { FakeQueue, FakeVerifier, Fixtures, testDb, testSettings } from "./helpers.ts";
import { createScenario, sha, type Scenario } from "./scenario.ts";

const db = testDb();
const fixtures = new Fixtures(db);
const verifier = new FakeVerifier();
const queue = new FakeQueue();
const github = new FakeGitHub();
const settings = testSettings();
const log = Fastify({ logger: false }).log;
const deps = { db, queue, github, log, settings };
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ settings, db, queue, verifier, github });
});
afterAll(async () => {
  await app.close();
  await fixtures.cleanup();
  await db.destroy();
});

const post = (userId: string, url: string, payload: object) =>
  app.inject({ method: "POST", url, headers: { authorization: `Bearer ${verifier.tokenFor(userId)}` }, payload });
const claim = (s: Scenario, userId: string, commitIds: string[], note?: string) =>
  post(userId, `/v1/submissions/${s.submissionId}/claims`, { commitIds, note });
const review = (userId: string, claimIds: string[], decision: "approve" | "reject", rememberEmail = false) =>
  post(userId, "/v1/commit-claims/review", { claimIds, decision, rememberEmail });
const notificationsOf = (userId: string) =>
  db.selectFrom("notifications").selectAll().where("user_id", "=", userId).orderBy("created_at").execute();
const commitsOf = (s: Scenario) =>
  db.selectFrom("commits").selectAll().where("repository_id", "=", s.repositoryId).orderBy("authored_at").execute();
const breakdown = async (s: Scenario) =>
  (
    await db
      .selectFrom("process_snapshots")
      .select(["breakdown", "is_final"])
      .where("submission_id", "=", s.submissionId)
      .executeTakeFirstOrThrow()
  ).breakdown as unknown as ProcessResult;

/**
 * Pushes commits by the student, written with the given git emails; GitHub matches `matched`
 * ones to the student's account and none of the others.
 */
async function push(s: Scenario, commits: { email: string; matched?: boolean }[]) {
  const studentGithubId = (
    await db.selectFrom("profiles").select("github_user_id").where("id", "=", s.student).executeTakeFirstOrThrow()
  ).github_user_id;
  const shas = commits.map(() => sha());
  await handlePush(deps, {
    ref: "refs/heads/main",
    after: shas.at(-1)!,
    repository: { id: s.githubRepoId, full_name: `${s.owner}/${s.name}`, pushed_at: Math.floor(Date.now() / 1000) },
    sender: { id: 2, login: "ada", type: "User" },
    commits: commits.map((c, i) => ({
      id: shas[i]!,
      message: `Work ${i}`,
      timestamp: new Date(Date.now() - (commits.length - i) * 60_000).toISOString(),
      distinct: true,
      author: { email: c.email, name: "Ada" },
    })),
  });
  commits.forEach((c, i) =>
    github.commits.set(`${s.owner}/${s.name}@${shas[i]}`.toLowerCase(), {
      sha: shas[i]!,
      authorId: c.matched ? Number(studentGithubId) : null,
      authorLogin: c.matched ? "ada" : null,
      authorIsBot: false,
      parentCount: 1,
      additions: 30,
      deletions: 0,
      files: [{ filename: `backend/src/f${i}.js`, additions: 30, deletions: 0 }],
    }),
  );
  await fetchCommitDetails(deps, s.repositoryId);
  await computeSubmissionProcess(deps, s.submissionId);
  return shas;
}

describe("commit claims", () => {
  it("let a student claim commits nobody is credited with, and course staff confirm them", async () => {
    const s = await createScenario(db, fixtures);
    await push(s, [
      { email: "ada@uni.test", matched: true },
      { email: "Ada@Laptop.test" },
      { email: "ada@laptop.test" },
    ]);
    const [mine, laptop1] = await commitsOf(s);
    expect(mine).toMatchObject({ author_profile_id: s.student, attribution: "github", author_email: "ada@uni.test" });
    expect(laptop1).toMatchObject({ author_profile_id: null, attribution: null, author_email: "ada@laptop.test" });
    expect((await breakdown(s)).unattributedCommits).toBe(2);
    const counted = (await breakdown(s)).meaningfulCommits;

    // Only the student, and only commits nobody is credited with.
    expect((await claim(s, s.otherStudent, [laptop1!.id])).statusCode).toBe(403);
    expect((await claim(s, s.student, [mine!.id])).json()).toMatchObject({ error: "already_credited" });
    expect((await claim(s, s.student, [])).statusCode).toBe(400);

    const res = await claim(s, s.student, [laptop1!.id], "My laptop's git email");
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ claimed: 1 });
    expect((await claim(s, s.student, [laptop1!.id])).json()).toEqual({ claimed: 0 }); // already asked
    const [n] = await notificationsOf(s.instructor);
    expect(n).toMatchObject({
      type: "commit_claim",
      body: "My laptop's git email",
      link: `/i/${s.slug}/courses/${s.courseId}/assignments/${s.assignmentId}/submissions/${s.submissionId}`,
    });
    expect(n!.title).toMatch(/claimed 1 commit in /);

    // Course staff decide, not the student or classmates.
    const k = await db
      .selectFrom("commit_claims")
      .selectAll()
      .where("commit_id", "=", laptop1!.id)
      .executeTakeFirstOrThrow();
    expect(k).toMatchObject({ status: "pending", claimed_by: s.student, note: "My laptop's git email" });
    expect((await review(s.student, [k.id], "approve")).statusCode).toBe(403);
    expect((await review(s.otherStudent, [k.id], "approve")).statusCode).toBe(403);

    // Confirmed, remembering the email: the claimed commit and the other one from that email
    // count for the student now.
    queue.sent.length = 0;
    const ok = await review(s.instructor, [k.id], "approve", true);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ decided: 1, rescored: 1 });
    const after = await commitsOf(s);
    expect(after[1]).toMatchObject({ author_profile_id: s.student, attribution: "claim" });
    expect(after[2]).toMatchObject({ author_profile_id: s.student, attribution: "alias" });
    expect(
      await db
        .selectFrom("commit_author_aliases")
        .select(["email", "profile_id", "confirmed_by"])
        .where("institution_id", "=", s.institutionId)
        .execute(),
    ).toEqual([{ email: "ada@laptop.test", profile_id: s.student, confirmed_by: s.instructor }]);
    const scored = await breakdown(s);
    expect(scored.unattributedCommits).toBe(0);
    expect(scored.meaningfulCommits).toBe(counted + 2);
    expect((await review(s.instructor, [k.id], "reject")).json()).toMatchObject({ error: "already_reviewed" });
    expect((await notificationsOf(s.student)).at(-1)).toMatchObject({
      type: "commit_claim",
      title: "Your claim to 1 commit was confirmed: they count for you now",
      link: `/i/${s.slug}/courses/${s.courseId}/assignments/${s.assignmentId}`,
    });

    // Later commits from that email are credited as they arrive.
    const [later] = await push(s, [{ email: "ADA@laptop.test" }]);
    expect(
      await db.selectFrom("commits").selectAll().where("sha", "=", later!).executeTakeFirstOrThrow(),
    ).toMatchObject({ author_profile_id: s.student, attribution: "alias", details_status: "done" });
    expect((await breakdown(s)).meaningfulCommits).toBe(counted + 3);
  });

  it("can be declined, and asked again", async () => {
    const s = await createScenario(db, fixtures);
    await push(s, [{ email: "someone@else.test" }]);
    const [c] = await commitsOf(s);
    await claim(s, s.student, [c!.id]);
    const k = await db.selectFrom("commit_claims").selectAll().where("commit_id", "=", c!.id).executeTakeFirstOrThrow();
    expect((await review(s.instructor, [k.id], "reject")).json()).toEqual({ decided: 1, rescored: 0 });
    expect(await db.selectFrom("commits").selectAll().where("id", "=", c!.id).executeTakeFirstOrThrow()).toMatchObject({
      author_profile_id: null,
      attribution: null,
    });
    expect((await notificationsOf(s.student)).at(-1)!.title).toBe("Your claim to 1 commit was declined");

    expect((await claim(s, s.student, [c!.id], "It really was me: see the PR")).json()).toEqual({ claimed: 1 });
    expect(
      await db
        .selectFrom("commit_claims")
        .select(["id", "status", "note", "reviewed_by"])
        .where("commit_id", "=", c!.id)
        .execute(),
    ).toEqual([{ id: k.id, status: "pending", note: "It really was me: see the PR", reviewed_by: null }]);
  });

  it("keep a frozen process score frozen, recounting only work from before the deadline, and regrade", async () => {
    const s = await createScenario(db, fixtures);
    await push(s, [{ email: "ada@uni.test", matched: true }, { email: "ada@old-laptop.test" }]);
    const [, c] = await commitsOf(s);
    // The deadline passed: the score is frozen and the submission finalized.
    await computeSubmissionProcess(deps, s.submissionId, { final: true });
    await db.updateTable("submissions").set({ finalized_at: new Date() }).where("id", "=", s.submissionId).execute();
    const before = await breakdown(s);
    expect(before.unattributedCommits).toBe(1);

    await claim(s, s.student, [c!.id]);
    const k = await db
      .selectFrom("commit_claims")
      .select("id")
      .where("commit_id", "=", c!.id)
      .executeTakeFirstOrThrow();
    queue.sent.length = 0;
    await review(s.instructor, [k.id], "approve");
    const snap = await db
      .selectFrom("process_snapshots")
      .select(["is_final", "breakdown"])
      .where("submission_id", "=", s.submissionId)
      .executeTakeFirstOrThrow();
    expect(snap.is_final).toBe(true);
    expect((snap.breakdown as unknown as ProcessResult).meaningfulCommits).toBe(before.meaningfulCommits + 1);
    expect(queue.sent).toContainEqual(
      expect.objectContaining({ name: "compute-grade", data: { submissionId: s.submissionId } }),
    );
  });

  it("are only for commits GitHub has finished analysing", async () => {
    const s = await createScenario(db, fixtures);
    const id = sha();
    await handlePush(deps, {
      ref: "refs/heads/main",
      after: id,
      repository: { id: s.githubRepoId, full_name: `${s.owner}/${s.name}`, pushed_at: Math.floor(Date.now() / 1000) },
      sender: { id: 2, login: "ada", type: "User" },
      commits: [
        { id, message: "Work", timestamp: new Date().toISOString(), distinct: true, author: { email: "x@y.test" } },
      ],
    });
    const [c] = await commitsOf(s);
    expect((await claim(s, s.student, [c!.id])).json()).toMatchObject({ error: "still_analysing" });
  });
});
