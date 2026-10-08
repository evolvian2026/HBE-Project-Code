import { describe, expect, it } from "vitest";
import {
  classifyCommit,
  computeProcessScore,
  effectiveLines,
  globToRegExp,
  linkedIssues,
  type CommitFacts,
  type ProcessPolicy,
} from "./process.ts";

const policy: ProcessPolicy = {
  criteria: [
    { key: "active_days", target: 6, weight: 40 },
    { key: "steady_progress", threshold: 0.4, weight: 25 },
    { key: "pr_workflow", target: 3, weight: 20 },
    { key: "issue_tracking", target: 3, weight: 15 },
  ],
  meaningful_commit_min_lines: 3,
  max_commits_per_day: 3,
};
const deadline = new Date("2026-10-20T15:59:00Z"); // 23:59 SGT
const commit = (iso: string, lines = 20, over: Partial<CommitFacts> = {}): CommitFacts => ({
  sha: Math.random().toString(16).slice(2).padEnd(40, "0"),
  authoredAt: new Date(iso),
  byStudent: true,
  isBot: false,
  parentCount: 1,
  effectiveLines: lines,
  ...over,
});

describe("classifyCommit", () => {
  it("explains why a commit does not count", () => {
    const at = "2026-10-15T03:00:00Z";
    expect(classifyCommit(commit(at), policy, deadline)).toEqual({ meaningful: true });
    expect(classifyCommit(commit(at, 2), policy, deadline)).toMatchObject({ reason: "too_small" });
    expect(classifyCommit(commit(at, 50, { parentCount: 2 }), policy, deadline)).toMatchObject({ reason: "merge" });
    expect(classifyCommit(commit(at, 50, { byStudent: false }), policy, deadline)).toMatchObject({
      reason: "not_student",
    });
    expect(classifyCommit(commit(at, 50, { isBot: true, byStudent: false }), policy, deadline)).toMatchObject({
      reason: "bot",
    });
    expect(classifyCommit(commit("2026-10-20T16:30:00Z"), policy, deadline)).toMatchObject({
      reason: "after_deadline",
    });
    expect(classifyCommit(commit(at, 50, { effectiveLines: null }), policy, deadline)).toMatchObject({
      reason: "pending",
    });
  });
});

describe("computeProcessScore", () => {
  it("gives full marks for steady, well-tracked work", () => {
    const commits = ["10", "11", "12", "14", "15", "17", "19"].map((d) => commit(`2026-10-${d}T04:00:00Z`));
    const result = computeProcessScore({
      policy,
      commits,
      pullRequests: [1, 4, 7].map((n) => ({
        byStudent: true,
        bodyLength: 120,
        linkedIssues: [n],
        mergedAt: new Date("2026-10-18T00:00:00Z"),
      })),
      issues: [1, 2, 3].map(() => ({ byStudent: true, closedAt: new Date("2026-10-18T00:00:00Z") })),
      deadline,
      timeZone: "Asia/Singapore",
    });
    expect(result.score).toBe(100);
    expect(result.criteria.every((c) => c.earned === 1)).toBe(true);
  });

  it("does not reward last-minute bursts or commit spam", () => {
    // 40 tiny-but-valid commits on the final evening, plus one earlier.
    const spam = Array.from({ length: 40 }, (_, i) => commit(`2026-10-20T1${i % 5}:00:00Z`, 10));
    const result = computeProcessScore({
      policy,
      commits: [commit("2026-10-12T04:00:00Z", 10), ...spam],
      pullRequests: [],
      issues: [],
      deadline,
      timeZone: "Asia/Singapore",
    });
    const days = result.criteria.find((c) => c.key === "active_days")!;
    expect(days.explanation).toMatch(/Active on 2 of 6 target days/);
    expect(result.creditedCommits).toBe(1 + 3); // capped at 3 per day
    const steady = result.criteria.find((c) => c.key === "steady_progress")!;
    // 75% late: credit falls linearly from the 40% limit to zero at 100%.
    expect(steady.earned).toBeCloseTo(1 - (0.75 - 0.4) / 0.6, 5);
    expect(steady.explanation).toMatch(/75% of your work came in the final 24 hours; aim for at most 40%/);
    // 2 of 6 days (13.33) + steady (10.42); 41 commits score the same as 4.
    expect(result.score).toBeCloseTo(23.75, 1);
  });

  it("counts calendar days in the course's time zone", () => {
    // 23:30 and 00:30 Singapore time are different days even though both are 15:30–16:30 UTC on one day.
    const result = computeProcessScore({
      policy,
      commits: [commit("2026-10-14T15:30:00Z"), commit("2026-10-14T16:30:00Z")],
      pullRequests: [],
      issues: [],
      deadline,
      timeZone: "Asia/Singapore",
    });
    expect(result.criteria[0]!.explanation).toMatch(/Active on 2 of 6/);
  });

  it("reports unattributed and pending commits and explains PR gaps", () => {
    const result = computeProcessScore({
      policy,
      commits: [
        commit("2026-10-14T04:00:00Z", 30, { byStudent: false }),
        commit("2026-10-14T05:00:00Z", 30, { effectiveLines: null }),
      ],
      pullRequests: [{ byStudent: true, bodyLength: 5, linkedIssues: [], mergedAt: new Date("2026-10-15T00:00:00Z") }],
      issues: [{ byStudent: true, closedAt: null }],
      deadline,
      timeZone: "Asia/Singapore",
    });
    expect(result.unattributedCommits).toBe(1);
    expect(result.pendingCommits).toBe(1);
    expect(result.criteria.find((c) => c.key === "pr_workflow")!.explanation).toBe(
      "0 of 3 merged pull requests have a description and link an issue (“Closes #12”); 1 merged without one.",
    );
    expect(result.score).toBe(0);
  });
});

describe("effective lines", () => {
  it("matches globs like the stack profiles use", () => {
    expect(globToRegExp("**/node_modules/**").test("frontend/node_modules/react/index.js")).toBe(true);
    expect(globToRegExp("**/node_modules/**").test("node_modules/x.js")).toBe(true);
    expect(globToRegExp("**/package-lock.json").test("package-lock.json")).toBe(true);
    expect(globToRegExp("**/package-lock.json").test("backend/package-lock.json")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false);
  });

  it("skips ignored files and whitespace-only changes", () => {
    const lines = effectiveLines(
      [
        { filename: "backend/package-lock.json", additions: 900, deletions: 10 },
        {
          filename: "backend/src/app.js",
          additions: 3,
          deletions: 1,
          patch: "@@ -1,2 +1,4 @@\n+const x = 1;\n+\n+   \n-old();\n context",
        },
        { filename: "frontend/logo.png", additions: 0, deletions: 0 },
        { filename: "README.md", additions: 2, deletions: 0 },
      ],
      ["**/package-lock.json", "**/node_modules/**"],
    );
    expect(lines).toBe(2 + 2); // app.js: "+const x = 1;" and "-old();"; README: no patch → 2
  });

  it("finds issues a pull request closes", () => {
    expect(linkedIssues("Implements login.\n\nCloses #12, fixes #3 and resolves: #12. See #99.")).toEqual([3, 12]);
    expect(linkedIssues(null)).toEqual([]);
  });
});
