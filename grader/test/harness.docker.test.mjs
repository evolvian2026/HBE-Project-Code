/**
 * Runs the real harness with Docker against the fixture apps. Needs Docker with Compose v2;
 * run with `pnpm --filter @hbe/grader test:docker`.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, describe, it } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(path.join(tmpdir(), "hbe-grader-test-"));
after(() => rmSync(work, { recursive: true, force: true }));

const profile = JSON.stringify({
  key: "node22-api",
  version: 1,
  detect: ["package.json", "compose.yaml"],
  services: { backend: { port: 4000, health: "/health" } },
  datastores: [],
  env_required: ["JWT_SECRET"],
});
const runId = "00000000-0000-4000-8000-000000000001";
const sha = "a".repeat(40);

/** The profile with the node22-api lint and test stages, and the assignment's options. */
const withStages = (options) =>
  JSON.stringify({
    ...JSON.parse(profile),
    stages: {
      lint: {
        image: "node:22-bookworm-slim",
        setup: "npm ci --no-audit --no-fund",
        run: "npm run lint",
        report: "text",
      },
      student_tests: {
        image: "node:22-bookworm-slim",
        setup: "npm ci --no-audit --no-fund",
        run: "npm test",
        report: "junit",
        junit: "junit.xml",
      },
    },
    options,
  });

async function harness(submission, extra = [], profileJson = profile) {
  const out = path.join(work, `results-${Math.random().toString(36).slice(2)}.json`);
  const args = [
    path.join(root, "harness/run.mjs"),
    "--run-id",
    runId,
    "--sha",
    sha,
    "--submission",
    submission,
    "--suite",
    path.join(root, "suites/sample/todo-api"),
    "--profile",
    profileJson,
    "--timeout-minutes",
    "10",
    "--out",
    out,
    ...(extra.length ? extra : ["--no-callback"]),
  ];
  await promisify(execFile)(process.execPath, args, { cwd: work, timeout: 600_000 });
  return JSON.parse(readFileSync(out, "utf8"));
}

const stage = (results, key) => results.stages.find((s) => s.key === key);
const failedIds = (results) =>
  results.stages
    .flatMap((s) => s.tests ?? [])
    .filter((t) => t.status !== "passed")
    .map((t) => t.id)
    .sort();

describe("grader harness (Docker)", { timeout: 900_000 }, () => {
  it("passes every hidden test for a correct submission", async () => {
    const results = await harness(path.join(root, "test-fixtures/todo-api-good"));
    assert.equal(results.infra_error, null);
    assert.deepEqual(
      results.stages.map((s) => [s.key, s.status]),
      [
        ["contract", "passed"],
        ["build", "passed"],
        ["health", "passed"],
        ["api", "passed"],
      ],
    );
    assert.equal(stage(results, "api").tests.length, 7);
    assert.deepEqual(failedIds(results), []);
  });

  it("reports failures with what was expected, evidence and the app's logs", async () => {
    const results = await harness(path.join(root, "test-fixtures/todo-api-buggy"));
    assert.deepEqual(failedIds(results), ["todos.create-requires-title", "todos.delete"]);
    const del = stage(results, "api").tests.find((t) => t.id === "todos.delete");
    assert.equal(del.expected, "HTTP 204");
    assert.equal(del.actual, "HTTP 200");
    assert.match(del.evidence.request, /^DELETE \/todos\//);
    assert.match(del.evidence.logs, /not implemented yet/);
    assert.ok(del.hint && del.staff_notes);
  });

  it("stops at the contract when the compose file reaches outside the container", async () => {
    const submission = path.join(work, "privileged");
    cpSync(path.join(root, "test-fixtures/todo-api-good"), submission, { recursive: true });
    writeFileSync(
      path.join(submission, "compose.yaml"),
      "services:\n  backend:\n    build: .\n    privileged: true\n    volumes:\n      - /:/host\n",
    );
    const results = await harness(submission);
    assert.equal(stage(results, "contract").status, "failed");
    assert.match(stage(results, "contract").message, /privileged/);
    assert.match(stage(results, "contract").message, /mounts \//);
    assert.deepEqual(
      results.stages.slice(1).map((s) => s.status),
      ["skipped", "skipped", "skipped"],
    );
    // The tests are listed, so the score shows what was missed.
    assert.equal(stage(results, "api").tests.length, 7);
  });

  it("reports a build failure from the student's Dockerfile", async () => {
    const submission = path.join(work, "broken-build");
    cpSync(path.join(root, "test-fixtures/todo-api-good"), submission, { recursive: true });
    writeFileSync(path.join(submission, "Dockerfile"), "FROM node:22-bookworm-slim\nRUN echo 'compiling…' && exit 3\n");
    const results = await harness(submission);
    assert.equal(results.infra_error, null);
    assert.equal(stage(results, "build").status, "failed");
    assert.match(stage(results, "build").message, /The build failed/);
  });

  it("runs lint and the student's own tests when the assignment turns them on", async () => {
    const options = { stages: { lint: { share: 10 }, student_tests: { share: 20 } }, skip_kinds: [] };
    const good = await harness(path.join(root, "test-fixtures/todo-api-good"), [], withStages(options));
    assert.equal(good.infra_error, null);
    assert.deepEqual(
      good.stages.map((s) => [s.key, s.status, s.share]),
      [
        ["contract", "passed", undefined],
        ["lint", "passed", 10],
        ["student_tests", "passed", 20],
        ["build", "passed", undefined],
        ["health", "passed", undefined],
        ["api", "passed", undefined],
      ],
    );
    assert.equal(stage(good, "student_tests").tests[0].message, "2 of 2 tests passed.");

    const buggy = await harness(path.join(root, "test-fixtures/todo-api-buggy"), [], withStages(options));
    const own = stage(buggy, "student_tests").tests[0];
    assert.equal(own.status, "failed");
    assert.equal(own.message, "1 of 2 tests failed.");
    assert.match(own.evidence.failures, /✗ test › rejects an empty title/);
    assert.match(own.evidence.output, /rejects an empty title/);
    assert.equal(stage(buggy, "lint").status, "passed");
  });

  it("reports a missing lint script and skips hidden stages the assignment turned off", async () => {
    const submission = path.join(work, "no-lint");
    cpSync(path.join(root, "test-fixtures/todo-api-good"), submission, { recursive: true });
    const pkg = JSON.parse(readFileSync(path.join(submission, "package.json"), "utf8"));
    delete pkg.scripts.lint;
    writeFileSync(path.join(submission, "package.json"), JSON.stringify(pkg));
    const results = await harness(submission, [], withStages({ stages: { lint: { share: 10 } }, skip_kinds: ["api"] }));
    const lint = stage(results, "lint").tests[0];
    assert.equal(lint.status, "failed");
    assert.equal(lint.message, "`npm run lint` exited with code 1.");
    assert.match(lint.evidence.output, /Missing script: "lint"/);
    assert.deepEqual(stage(results, "api"), {
      key: "api",
      status: "skipped",
      duration_ms: 0,
      message: "Turned off for this assignment.",
    });
    assert.equal(stage(results, "student_tests"), undefined);
  });

  it("calls back with the run token: started, then results", async () => {
    const { calls } = await withPlatform(path.join(root, "test-fixtures/todo-api-good"), () => ({}));
    assert.deepEqual(
      calls.map((c) => [c.url, c.auth]),
      [
        [`/v1/runs/${runId}/started`, "Bearer local-run-token"],
        [`/v1/runs/${runId}/snapshot-uploads`, "Bearer local-run-token"],
        [`/v1/runs/${runId}/results`, "Bearer local-run-token"],
      ],
    );
    assert.equal(calls[2].body.run_id, runId);
    assert.equal(calls[2].body.stages.length, 4);
    assert.equal(calls[2].body.snapshot, undefined); // not a graded run
  });

  it("archives a graded commit: a git bundle and a tarball, with their hashes", async () => {
    const submission = path.join(work, "git-submission");
    cpSync(path.join(root, "test-fixtures/todo-api-good"), submission, { recursive: true });
    const git = (...args) =>
      promisify(execFile)("git", [
        "-C",
        submission,
        "-c",
        "user.name=Ada",
        "-c",
        "user.email=ada@example.test",
        ...args,
      ]);
    await git("init", "-q", "-b", "main");
    await git("add", ".");
    await git("commit", "-q", "-m", "Finish the API");

    const { calls, uploads } = await withPlatform(submission, (port) => ({
      bundle: { path: "x.bundle", url: `http://127.0.0.1:${port}/upload/bundle?token=t` },
      tarball: { path: "x.tar.gz", url: `http://127.0.0.1:${port}/upload/tarball?token=t` },
    }));
    const results = calls.find((c) => c.url.endsWith("/results")).body;
    const bundle = uploads.get("/upload/bundle?token=t");
    const tarball = uploads.get("/upload/tarball?token=t");
    assert.equal(bundle.type, "application/x-git-bundle");
    assert.equal(tarball.type, "application/gzip");
    assert.deepEqual(results.snapshot, {
      bundle_sha256: createHash("sha256").update(bundle.body).digest("hex"),
      bundle_size: bundle.body.length,
      tarball_sha256: createHash("sha256").update(tarball.body).digest("hex"),
      tarball_size: tarball.body.length,
    });
    // The bundle is a complete, verifiable copy of the history.
    const file = path.join(work, "check.bundle");
    writeFileSync(file, bundle.body);
    await promisify(execFile)("git", ["-C", submission, "bundle", "verify", file]);
  });
});

/**
 * Runs the harness against a stand-in platform API that records callbacks and uploads.
 * `uploadTargets(port)` answers the snapshot-uploads callback.
 */
async function withPlatform(submission, uploadTargets) {
  const calls = [];
  const uploads = new Map();
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      if (req.method === "PUT") {
        uploads.set(req.url, { type: req.headers["content-type"], body });
        res.writeHead(200).end("{}");
        return;
      }
      calls.push({ url: req.url, auth: req.headers.authorization, body: body.length ? JSON.parse(body) : null });
      const reply = req.url.endsWith("/snapshot-uploads") ? uploadTargets(server.address().port) : { ok: true };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await harness(submission, ["--api-url", `http://127.0.0.1:${server.address().port}`, "--token", "local-run-token"]);
  } finally {
    server.close();
  }
  return { calls, uploads };
}
