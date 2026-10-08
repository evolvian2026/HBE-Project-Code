/**
 * Runs the real harness with Docker against the fixture apps. Needs Docker with Compose v2;
 * run with `pnpm --filter @hbe/grader test:docker`.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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

async function harness(submission, extra = []) {
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
    profile,
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

  it("calls back with the run token: started, then results", async () => {
    const calls = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        calls.push({ url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
        res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address();
      await harness(path.join(root, "test-fixtures/todo-api-good"), [
        "--api-url",
        `http://127.0.0.1:${port}`,
        "--token",
        "local-run-token",
      ]);
    } finally {
      server.close();
    }
    assert.deepEqual(
      calls.map((c) => [c.url, c.auth]),
      [
        [`/v1/runs/${runId}/started`, "Bearer local-run-token"],
        [`/v1/runs/${runId}/results`, "Bearer local-run-token"],
      ],
    );
    assert.equal(calls[1].body.run_id, runId);
    assert.equal(calls[1].body.stages.length, 4);
  });
});
