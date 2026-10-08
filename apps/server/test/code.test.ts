import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FakeGitHub } from "@hbe/github";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { FakeQueue, FakeVerifier, Fixtures, testDb, testSettings } from "./helpers.ts";
import { createScenario, type Scenario } from "./scenario.ts";

const db = testDb();
const fixtures = new Fixtures(db);
const verifier = new FakeVerifier();
const gitRoot = mkdtempSync(path.join(tmpdir(), "hbe-code-"));
let app: FastifyInstance;
let s: Scenario;
let start: string;
let head: string;

beforeAll(async () => {
  s = await createScenario(db, fixtures);
  // The student's repository: the template's commit, then their work.
  const repo = path.join(gitRoot, s.owner, s.name);
  mkdirSync(path.join(repo, "src"), { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, "-c", "user.name=Ada", "-c", "user.email=ada@example.test", ...args], {
      encoding: "utf8",
    }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "src", "server.js"), "// TODO\n");
  git("add", ".");
  git("commit", "-q", "-m", "Initial commit");
  start = git("rev-parse", "HEAD");
  writeFileSync(
    path.join(repo, "src", "server.js"),
    "import http from 'node:http';\nhttp.createServer().listen(4000);\n",
  );
  writeFileSync(path.join(repo, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]));
  git("add", ".");
  git("commit", "-q", "-m", "Server");
  head = git("rev-parse", "HEAD");
  await db.updateTable("repositories").set({ head_sha: head }).where("id", "=", s.repositoryId).execute();

  app = await buildApp({
    settings: testSettings(),
    db,
    queue: new FakeQueue(),
    verifier,
    github: new FakeGitHub({ gitRoot }),
  });
});

afterAll(async () => {
  await app.close();
  await fixtures.cleanup();
  await db.destroy();
  rmSync(gitRoot, { recursive: true, force: true });
});

const get = (userId: string, url: string) =>
  app.inject({ url, headers: { authorization: `Bearer ${verifier.tokenFor(userId)}` } });

describe("code review API", () => {
  it("shows course staff the files at the latest push", async () => {
    const res = await get(s.instructor, `/v1/submissions/${s.submissionId}/code/tree`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      sha: head,
      truncated: false,
      entries: [
        { path: "logo.png", type: "blob", size: 8 },
        { path: "src", type: "tree", size: null },
        { path: "src/server.js", type: "blob", size: 64 },
      ],
    });
    expect((await get(s.student, `/v1/submissions/${s.submissionId}/code/tree`)).statusCode).toBe(403);
  });

  it("reads text files and describes binary ones", async () => {
    const text = await get(s.instructor, `/v1/submissions/${s.submissionId}/code/file?path=src/server.js&sha=${start}`);
    expect(text.json()).toMatchObject({ path: "src/server.js", sha: start, binary: false, content: "// TODO\n" });
    const binary = await get(s.instructor, `/v1/submissions/${s.submissionId}/code/file?path=logo.png`);
    expect(binary.json()).toMatchObject({ binary: true, content: null, size: 8 });
    expect((await get(s.instructor, `/v1/submissions/${s.submissionId}/code/file?path=nope.js`)).statusCode).toBe(404);
  });

  it("diffs from where the student started, and remembers that commit", async () => {
    const res = await get(s.instructor, `/v1/submissions/${s.submissionId}/code/compare`);
    expect(res.json()).toMatchObject({
      base: start,
      head,
      totalCommits: 1,
      files: [
        { filename: "logo.png", status: "added" },
        {
          filename: "src/server.js",
          status: "modified",
          additions: 2,
          deletions: 1,
          patch: expect.stringContaining("+http.createServer().listen(4000);"),
        },
      ],
    });
    const repo = await db
      .selectFrom("repositories")
      .select("start_sha")
      .where("id", "=", s.repositoryId)
      .executeTakeFirstOrThrow();
    expect(repo.start_sha).toBe(start);
  });
});
