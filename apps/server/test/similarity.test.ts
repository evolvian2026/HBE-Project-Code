import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FakeGitHub } from "@hbe/github";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { checkSimilarity } from "../src/similarity.ts";
import { MemoryObjectStore } from "../src/storage.ts";
import { ADA, ADA_DISGUISED, GRACE, LIN, STARTER } from "./fixtures/similar-code.ts";
import { FakeQueue, FakeVerifier, Fixtures, testDb, testSettings } from "./helpers.ts";
import { createScenario, type Scenario } from "./scenario.ts";

const db = testDb();
const fixtures = new Fixtures(db);
const verifier = new FakeVerifier();
const queue = new FakeQueue();
const store = new MemoryObjectStore();
const gitRoot = mkdtempSync(path.join(tmpdir(), "hbe-similarity-"));
const github = new FakeGitHub({ gitRoot });
const log = { info() {}, warn() {}, error() {} } as never;
let app: FastifyInstance;
let s: Scenario;
const subs: Record<string, string> = {};

/**
 * A student's repository: the starter as its first commit, then their file; graded at the
 * cutoff, with the commit archived as a tarball (unless `archived` is false).
 */
async function student(key: string, userId: string, code: string, archived = true) {
  const name = `todo-api-${key}`;
  const dir = path.join(gitRoot, s.owner, name);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, "-c", "user.name=S", "-c", "user.email=s@example.test", ...args], {
      encoding: "utf8",
    }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(path.join(dir, "src", "app.js"), STARTER);
  git("add", ".");
  git("commit", "-q", "-m", "Initial commit");
  writeFileSync(path.join(dir, "src", "todos.js"), code);
  writeFileSync(path.join(dir, "package-lock.json"), "{}");
  git("add", ".");
  git("commit", "-q", "-m", "Todos");
  const sha = git("rev-parse", "HEAD");
  const tarball = path.join(gitRoot, `${key}.tar.gz`);
  git("archive", "--format=tar.gz", "-o", tarball, "HEAD");

  const gh = await db
    .selectFrom("repositories")
    .select("github_installation_id")
    .where("id", "=", s.repositoryId)
    .executeTakeFirstOrThrow();
  const repo = await db
    .insertInto("repositories")
    .values({
      institution_id: s.institutionId,
      github_installation_id: gh.github_installation_id,
      owner: s.owner,
      name,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const existing = await db
    .selectFrom("submissions")
    .select("id")
    .where("assignment_id", "=", s.assignmentId)
    .where("user_id", "=", userId)
    .executeTakeFirst();
  const values = { repository_id: repo.id, final_sha: sha, status: "graded" as const, finalized_at: new Date() };
  const submissionId = existing
    ? (
        await db
          .updateTable("submissions")
          .set(values)
          .where("id", "=", existing.id)
          .returning("id")
          .executeTakeFirstOrThrow()
      ).id
    : (
        await db
          .insertInto("submissions")
          .values({ institution_id: s.institutionId, assignment_id: s.assignmentId, user_id: userId, ...values })
          .returning("id")
          .executeTakeFirstOrThrow()
      ).id;
  if (archived) {
    const base = `${s.institutionId}/${submissionId}/${sha}`;
    await store.put("submission-archive", `${base}.tar.gz`, readFileSync(tarball), "application/gzip");
    await db
      .insertInto("submission_snapshots")
      .values({
        institution_id: s.institutionId,
        submission_id: submissionId,
        sha,
        bundle_path: `${base}.bundle`,
        bundle_sha256: "0".repeat(64),
        bundle_size: 0,
        tarball_path: `${base}.tar.gz`,
        tarball_sha256: "0".repeat(64),
        tarball_size: 0,
      })
      .execute();
  }
  subs[key] = submissionId;
}

beforeAll(async () => {
  app = await buildApp({ settings: testSettings(), db, queue, verifier, github });
  s = await createScenario(db, fixtures);
});
afterAll(async () => {
  await app.close();
  await fixtures.cleanup();
  await db.destroy();
  rmSync(gitRoot, { recursive: true, force: true });
});

const call = (method: "GET" | "POST", userId: string) =>
  app.inject({
    method,
    url: `/v1/assignments/${s.assignmentId}/similarity`,
    headers: { authorization: `Bearer ${verifier.tokenFor(userId)}` },
  });

describe("similar code", () => {
  it("is for course staff, once there are graded submissions to compare", async () => {
    expect((await call("POST", s.student)).statusCode).toBe(403);
    expect((await call("GET", s.student)).statusCode).toBe(403);
    expect((await call("POST", s.instructor)).json()).toMatchObject({ error: "too_few" });
    expect((await call("GET", s.instructor)).json()).toEqual({ report: null, pairs: [] });
  });

  it("finds the disguised copy and where it is, leaving out the starter code", async () => {
    const member = async () => {
      const userId = await fixtures.user();
      await db
        .insertInto("institution_memberships")
        .values({ institution_id: s.institutionId, user_id: userId, role: "student" })
        .execute();
      return userId;
    };
    const more = [await member(), await member()];
    await student("ada", s.student, ADA);
    await student("grace", s.otherStudent, GRACE);
    await student("lin", more[0]!, LIN);
    await student("copy", more[1]!, ADA_DISGUISED);
    const unarchived = await member();
    await student("late", unarchived, ADA, false);

    const started = await call("POST", s.instructor);
    expect(started.statusCode).toBe(202);
    const { id } = started.json();
    expect(queue.sent.at(-1)).toMatchObject({ name: "similarity-check", data: { reportId: id } });
    // One check at a time.
    expect((await call("POST", s.instructor)).json()).toEqual({ id, status: "already_running" });

    await checkSimilarity({ db, store, github, log }, id);
    const body = (await call("GET", s.instructor)).json();
    expect(body.report).toMatchObject({
      id,
      status: "completed",
      compared: 4,
      starterExcluded: true,
      skipped: [{ submission_id: subs.late, reason: "The graded commit wasn't archived." }],
    });
    // The starter (src/app.js, in every repository) and Ada's code in "late" don't count.
    expect(body.pairs).toHaveLength(1);
    const [pair] = body.pairs;
    expect([pair.a.submissionId, pair.b.submissionId].sort()).toEqual([subs.ada, subs.copy].sort());
    expect(pair.score).toBeGreaterThan(0.9);
    expect(pair.a.people).toHaveLength(1);
    expect(pair.matches[0]).toMatchObject({ a: { path: "src/todos.js" }, b: { path: "src/todos.js" } });
    expect(pair.matches[0].a.to - pair.matches[0].a.from).toBeGreaterThan(15);
  });
});
