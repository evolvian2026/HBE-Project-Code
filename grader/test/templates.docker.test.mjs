/**
 * Grades every starter template (templates/<profile>) with the real harness and its stack
 * profile (grader/stacks/<profile>.json), with lint and the student's tests turned on: a
 * student's first push must build, start and pass everything. Needs Docker with internet
 * access (the builds and the lint/test setup install dependencies); CI job "Starter templates".
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, describe, it } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(path.join(tmpdir(), "hbe-templates-test-"));
after(() => rmSync(work, { recursive: true, force: true }));

// node22-api's example has no notes API: only the profile's own stages run for it.
const emptySuite = path.join(work, "empty-suite");
mkdirSync(emptySuite);
writeFileSync(path.join(emptySuite, "suite.json"), JSON.stringify({ key: "empty", version: 1, stages: [] }));

const SUITES = {
  "node22-api": emptySuite,
  "mern-node20": path.join(root, "suites/sample/starter-notes"),
  "django-react": path.join(root, "suites/sample/starter-notes"),
};

describe("starter templates (Docker)", { timeout: 2_400_000 }, () => {
  for (const [key, suite] of Object.entries(SUITES)) {
    it(`${key}: builds, starts, lints, passes its own tests and the sample suite`, async () => {
      const profile = {
        key,
        version: 1,
        ...JSON.parse(readFileSync(path.join(root, "stacks", `${key}.json`), "utf8")),
        options: { stages: { lint: { share: 10 }, student_tests: { share: 10 } }, skip_kinds: [] },
      };
      const out = path.join(work, `${key}.json`);
      await promisify(execFile)(
        process.execPath,
        [
          path.join(root, "harness/run.mjs"),
          ...["--run-id", "00000000-0000-4000-8000-0000000000aa", "--sha", "a".repeat(40)],
          ...["--submission", path.resolve(root, "../templates", key)],
          ...["--suite", suite, "--profile", JSON.stringify(profile)],
          ...["--timeout-minutes", "20", "--out", out, "--no-callback"],
        ],
        { timeout: 1_500_000, maxBuffer: 64 * 1024 * 1024 },
      );
      const results = JSON.parse(readFileSync(out, "utf8"));
      assert.equal(results.infra_error, null);
      const failed = results.stages
        .flatMap((s) => (s.tests?.length ? s.tests.map((t) => ({ ...t, stage: s.key })) : [{ ...s, stage: s.key }]))
        .filter((t) => t.status !== "passed");
      assert.deepEqual(failed, [], JSON.stringify(failed, null, 2));
    });
  }
});
