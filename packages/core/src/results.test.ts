import { describe, expect, it } from "vitest";
import { checkRunSummary, scoreRun, type RunResults, type TestResult } from "./results.ts";

const test = (id: string, status: TestResult["status"], weight = 1, extra: Partial<TestResult> = {}): TestResult => ({
  id,
  title: id,
  status,
  weight,
  ...extra,
});
const run = (stages: RunResults["stages"], infra_error: string | null = null): RunResults => ({
  run_id: "r",
  sha: "a".repeat(40),
  started_at: "",
  finished_at: "",
  infra_error,
  stages,
});
const gates = (status: TestResult["status"] = "passed") =>
  ["contract", "build", "health"].map((key) => ({ key, status, duration_ms: 1 }));

describe("scoreRun", () => {
  it("weights tests across stages", () => {
    const s = scoreRun(
      run([
        ...gates(),
        { key: "api", status: "failed", duration_ms: 1, tests: [test("a", "passed", 2), test("b", "failed", 1)] },
        { key: "e2e", status: "passed", duration_ms: 1, tests: [test("c", "passed", 1)] },
      ]),
    );
    expect(s).toEqual({ score: 75, passed: 2, failed: 1, total: 3, blockedBy: null });
  });

  it("scores 0 when a gating stage fails (the tests never ran)", () => {
    const s = scoreRun(
      run([
        { key: "contract", status: "passed", duration_ms: 1 },
        { key: "build", status: "failed", duration_ms: 1, message: "npm ERR!" },
        { key: "api", status: "skipped", duration_ms: 0, tests: [test("a", "skipped"), test("b", "skipped")] },
      ]),
    );
    expect(s).toEqual({ score: 0, passed: 0, failed: 2, total: 2, blockedBy: "build" });
  });

  it("does not grade platform failures", () => {
    expect(scoreRun(run([], "runner lost")).score).toBeNull();
  });

  it("has nothing to grade without tests", () => {
    expect(scoreRun(run(gates())).score).toBeNull();
  });
});

describe("scoreRun with stage shares", () => {
  const lint = (status: TestResult["status"]) => ({
    key: "lint",
    status,
    duration_ms: 1,
    share: 10,
    tests: [test("lint", status)],
  });
  const ownTests = (status: TestResult["status"]) => ({
    key: "student_tests",
    status,
    duration_ms: 1,
    share: 20,
    tests: [test("student_tests", status)],
  });
  const api = {
    key: "api",
    status: "failed" as const,
    duration_ms: 1,
    tests: [test("a", "passed", 3), test("b", "failed", 1)],
  };

  it("gives shared stages their percent and the hidden tests the rest", () => {
    // 10% lint (passed) + 20% own tests (failed) + 70% × 3/4 hidden = 10 + 0 + 52.5
    expect(scoreRun(run([...gates(), lint("passed"), ownTests("failed"), api])).score).toBe(62.5);
    expect(scoreRun(run([...gates(), lint("passed"), ownTests("passed"), api])).score).toBe(82.5);
  });

  it("rescales when there are no hidden tests", () => {
    expect(scoreRun(run([...gates(), lint("passed"), ownTests("failed")])).score).toBe(33.33);
  });

  it("still scores 0 when a gating stage fails", () => {
    const blocked = run([...gates("failed"), lint("passed"), ownTests("passed"), api]);
    expect(scoreRun(blocked)).toMatchObject({ score: 0, blockedBy: "contract" });
  });
});

describe("checkRunSummary", () => {
  it("lists failures with expected, actual and hints", () => {
    const results = run([
      ...gates(),
      {
        key: "api",
        status: "failed",
        duration_ms: 1,
        tests: [
          test("login", "failed", 1, {
            title: "Rejects a wrong password",
            expected: "HTTP 401",
            actual: "HTTP 500",
            hint: "Catch bad credentials",
            staff_notes: "secret",
          }),
        ],
      },
    ]);
    const { title, summary } = checkRunSummary(results, scoreRun(results), "https://app.example.com/run/1");
    expect(title).toBe("0/1 tests passed · score 0");
    expect(summary).toContain("**Rejects a wrong password**");
    expect(summary).toContain("expected: `HTTP 401` · actual: `HTTP 500`");
    expect(summary).toContain("hint: Catch bad credentials");
    expect(summary).not.toContain("secret");
  });
});
