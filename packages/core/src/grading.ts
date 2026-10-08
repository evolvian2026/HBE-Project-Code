/**
 * The final grade: Σ weight × component score, less the late penalty (docs/ARCHITECTURE.md §6.6).
 * Recomputed from its inputs whenever one changes; each result is stored as a new version.
 */
import type { LatePolicy, Weights } from "./assignments.ts";

export interface GradeInputs {
  weights: Weights;
  /** Score of the graded test run (0–100), or null while there is none. */
  automated: { score: number | null; runId: string | null };
  rubric: { points: number; maxPoints: number; scored: number; criteria: number };
  /** The frozen process score (0–100), or null if there was no activity at all. */
  process: { score: number | null };
  /** Nothing was pushed before the cutoff. */
  missing: boolean;
  lateDays: number;
  latePolicy: LatePolicy;
}

export interface GradeComponent {
  weight: number;
  /** 0–100; null while missing. */
  score: number | null;
  /** Weighted points this component adds to the grade (out of 100). */
  points: number;
}

export interface GradeResult {
  components: {
    automated: GradeComponent & { runId: string | null };
    rubric: GradeComponent & { points_awarded: number; max_points: number };
    process: GradeComponent;
  };
  /** What still has to happen before the grade can be released. */
  pending: string[];
  /** Before the late penalty. */
  raw: number;
  /** Percent of the grade deducted for lateness. */
  latePenalty: number;
  computed: number;
  complete: boolean;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function computeGrade(input: GradeInputs): GradeResult {
  const { weights } = input;
  const pending: string[] = [];

  // A missing submission has no test run to wait for: its automated score is 0.
  const automatedScore = input.missing ? 0 : input.automated.score;
  if (weights.automated > 0 && automatedScore === null) pending.push("the graded test run");

  const { points: rubricPoints, maxPoints, scored, criteria } = input.rubric;
  const rubricScore = criteria === 0 || maxPoints === 0 ? null : (rubricPoints / maxPoints) * 100;
  if (weights.rubric > 0 && scored < criteria) {
    const left = criteria - scored;
    pending.push(`rubric scores for ${left} criteri${left === 1 ? "on" : "a"}`);
  }

  const processScore = input.process.score ?? 0;

  const component = (weight: number, score: number | null): GradeComponent => ({
    weight,
    score: score === null ? null : round2(score),
    points: round2(((score ?? 0) * weight) / 100),
  });
  const automated = component(weights.automated, automatedScore);
  const rubric = component(weights.rubric, rubricScore);
  const process = component(weights.process, processScore);

  const raw = round2(automated.points + rubric.points + process.points);
  const latePenalty = Math.min(100, Math.max(0, input.lateDays) * input.latePolicy.per_day_percent);
  const computed = round2(Math.min(100, Math.max(0, raw * (1 - latePenalty / 100))));
  return {
    components: {
      automated: { ...automated, runId: input.automated.runId },
      rubric: { ...rubric, points_awarded: round2(rubricPoints), max_points: round2(maxPoints) },
      process,
    },
    pending,
    raw,
    latePenalty,
    computed,
    complete: pending.length === 0,
  };
}
