/**
 * Results reported by the grader harness (docs/ARCHITECTURE.md §6.5) and how a run is scored.
 */
export type ResultStatus = "passed" | "failed" | "skipped" | "error";

export interface TestResult {
  id: string;
  title: string;
  category?: string;
  status: ResultStatus;
  weight: number;
  duration_ms?: number;
  expected?: string;
  actual?: string;
  message?: string;
  hint?: string;
  /** Short text evidence shown to the student (request/response excerpts, log windows). */
  evidence?: Record<string, string>;
  /** Shown to course staff only. */
  staff_notes?: string;
}

export interface StageResult {
  key: string;
  status: ResultStatus;
  duration_ms: number;
  message?: string;
  /**
   * Percent of the automated score this stage is worth (lint and the student's own tests, as
   * the assignment sets them). Stages without a share split the rest by test weight.
   */
  share?: number;
  tests?: TestResult[];
}

export interface RunResults {
  run_id: string;
  sha: string;
  started_at: string;
  finished_at: string;
  /** Set when the failure is the platform's, not the student's: the run is retried, never graded. */
  infra_error: string | null;
  stages: StageResult[];
}

/** Stages that must pass for the hidden tests to run at all. */
export const GATING_STAGES = ["contract", "build", "health"] as const;

export interface RunScore {
  /** 0–100, or null when there is nothing to grade (infra error, or no tests in the suite). */
  score: number | null;
  passed: number;
  failed: number;
  total: number;
  /** First gating stage that failed, if any (then all tests count as failed). */
  blockedBy: string | null;
}

export function scoreRun(results: RunResults): RunScore {
  if (results.infra_error) return { score: null, passed: 0, failed: 0, total: 0, blockedBy: null };
  const blocked = results.stages.find(
    (s) => (GATING_STAGES as readonly string[]).includes(s.key) && s.status !== "passed",
  );
  const tests = results.stages.flatMap((s) => s.tests ?? []).filter((t) => t.status !== "skipped" || blocked);
  const total = tests.length;
  if (total === 0)
    return { score: blocked ? 0 : null, passed: 0, failed: 0, total: 0, blockedBy: blocked?.key ?? null };

  const weightOf = (t: TestResult) => (Number.isFinite(t.weight) && t.weight >= 0 ? t.weight : 1);
  const counted = (t: TestResult) => t.status !== "skipped" || blocked;
  const passedTests = blocked ? [] : tests.filter((t) => t.status === "passed");
  /** Weighted share of passed tests, or null without weight to share. */
  const ratio = (group: TestResult[]) => {
    const all = group.reduce((s, t) => s + weightOf(t), 0);
    if (all === 0) return null;
    return (blocked ? 0 : group.filter((t) => t.status === "passed").reduce((s, t) => s + weightOf(t), 0)) / all;
  };

  // Stages with a share are worth that percent; the remaining tests share the rest.
  const parts: { share: number; ratio: number }[] = [];
  let shared = 0;
  for (const stage of results.stages) {
    const share = Number.isFinite(stage.share) ? Math.min(100, Math.max(0, stage.share!)) : null;
    if (share === null) continue;
    const r = ratio((stage.tests ?? []).filter(counted));
    if (r === null) continue;
    parts.push({ share, ratio: r });
    shared += share;
  }
  const rest = ratio(
    results.stages.filter((s) => !Number.isFinite(s.share)).flatMap((s) => (s.tests ?? []).filter(counted)),
  );
  if (rest !== null && shared < 100) parts.push({ share: 100 - shared, ratio: rest });
  const totalShare = parts.reduce((s, p) => s + p.share, 0);
  const score = totalShare === 0 ? null : parts.reduce((s, p) => s + p.share * p.ratio, 0) / totalShare;
  return {
    score: score === null ? null : Math.round(score * 10000) / 100,
    passed: passedTests.length,
    failed: total - passedTests.length,
    total,
    blockedBy: blocked?.key ?? null,
  };
}

/** Markdown summary for the GitHub check run: failures with their evidence, never the test code. */
export function checkRunSummary(results: RunResults, s: RunScore, runUrl: string): { title: string; summary: string } {
  if (results.infra_error) {
    return {
      title: "The grader could not run",
      summary: `This was a platform problem, not your code. It will be retried.\n\n${results.infra_error}`,
    };
  }
  const title = s.blockedBy
    ? `Stopped at ${s.blockedBy}: tests could not run`
    : `${s.passed}/${s.total} tests passed${s.score === null ? "" : ` · score ${s.score}`}`;
  const lines: string[] = [];
  const blockedStage = results.stages.find((st) => st.key === s.blockedBy);
  if (blockedStage)
    lines.push(`**${blockedStage.key}** failed: ${blockedStage.message ?? "see the run for details"}`, "");
  const failures = results.stages.flatMap((st) =>
    (st.tests ?? []).filter((t) => t.status === "failed" || t.status === "error"),
  );
  for (const t of failures.slice(0, 15)) {
    lines.push(`- ❌ **${t.title}**${t.category ? ` _(${t.category})_` : ""}`);
    if (t.expected || t.actual)
      lines.push(
        `  - expected: \`${(t.expected ?? "").slice(0, 200)}\` · actual: \`${(t.actual ?? "").slice(0, 200)}\``,
      );
    if (t.hint) lines.push(`  - hint: ${t.hint}`);
  }
  if (failures.length > 15) lines.push(`- …and ${failures.length - 15} more`);
  lines.push("", `[Full results and evidence](${runUrl})`);
  return { title, summary: lines.join("\n") };
}
