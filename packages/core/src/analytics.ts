/**
 * Course analytics for staff (Phase 3B): distributions and a transparent, rule-based view of
 * students who may need help. Signals only: they prompt a conversation and never change a grade.
 */

/** The middle value (the mean of the two middle ones for an even count), or null. */
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Counts of 0–100 scores in bins of `size` (the last bin includes 100). */
export function distribution(values: number[], size = 10): { from: number; to: number; count: number }[] {
  const bins = Array.from({ length: Math.ceil(100 / size) }, (_, i) => ({
    from: i * size,
    to: Math.min(100, (i + 1) * size),
    count: 0,
  }));
  for (const v of values) {
    const clamped = Math.max(0, Math.min(100, v));
    bins[Math.min(bins.length - 1, Math.floor(clamped / size))]!.count++;
  }
  return bins;
}

/** Below this many students, cohort figures are withheld so nobody can be singled out. */
export const MIN_COHORT = 5;

export interface FinishedAssignment {
  title: string;
  /** The final grade (0–100), if graded. */
  score: number | null;
  lateDays: number;
  /** Nothing was pushed before the cutoff. */
  missing: boolean;
  processScore: number | null;
}

export interface StudentRiskInput {
  /** Assignments past their cutoff, oldest first. */
  finished: FinishedAssignment[];
  /** Signals on open assignments (riskFlags), already prefixed with the assignment's title. */
  current: string[];
}

export interface RiskAssessment {
  level: "high" | "medium" | null;
  reasons: string[];
}

export interface StudentRiskPolicy {
  /** Average of the last three grades below this is a concern. */
  lowGradeBelow: number;
  /** This many late submissions or more. */
  lateCount: number;
  /** A fall of this many points between the last two grades. */
  dropPoints: number;
  /** Process score below this on the latest assignment. */
  lowProcessBelow: number;
}

export const DEFAULT_STUDENT_RISK_POLICY: StudentRiskPolicy = {
  lowGradeBelow: 50,
  lateCount: 2,
  dropPoints: 20,
  lowProcessBelow: 40,
};

/**
 * Whether a student may need help, and why, from what they've done so far. Each reason has a
 * weight (missed work and a low average weigh 2, the rest 1, current signals at most 2 in all):
 * 3 or more is "high", 1 or more "medium". Every reason is spelled out, so staff can see and
 * question it.
 */
export function assessStudentRisk(
  input: StudentRiskInput,
  policy: StudentRiskPolicy = DEFAULT_STUDENT_RISK_POLICY,
): RiskAssessment {
  const reasons: string[] = [];
  let weight = 0;
  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

  const missing = input.finished.filter((a) => a.missing);
  if (missing.length) {
    reasons.push(
      `nothing submitted for ${missing.length} ${plural(missing.length, "assignment", "assignments")} (${missing.map((a) => a.title).join(", ")})`,
    );
    weight += 2;
  }

  const graded = input.finished.filter((a) => a.score !== null);
  const recent = graded.slice(-3);
  if (recent.length) {
    const avg = recent.reduce((s, a) => s + a.score!, 0) / recent.length;
    if (avg < policy.lowGradeBelow) {
      reasons.push(
        `average grade ${Math.round(avg)} over the last ${recent.length} ${plural(recent.length, "assignment", "assignments")}`,
      );
      weight += 2;
    }
  }
  if (graded.length >= 2) {
    const [before, last] = graded.slice(-2) as [FinishedAssignment, FinishedAssignment];
    if (before.score! - last.score! >= policy.dropPoints) {
      reasons.push(`grade fell from ${Math.round(before.score!)} to ${Math.round(last.score!)} (${last.title})`);
      weight += 1;
    }
  }

  const late = input.finished.filter((a) => a.lateDays > 0 && !a.missing);
  if (late.length >= policy.lateCount) {
    reasons.push(`late on ${late.length} assignments`);
    weight += 1;
  }

  const latest = input.finished.at(-1);
  if (latest && !latest.missing && latest.processScore !== null && latest.processScore < policy.lowProcessBelow) {
    reasons.push(`process score ${Math.round(latest.processScore)} on ${latest.title}`);
    weight += 1;
  }

  reasons.push(...input.current);
  weight += Math.min(2, input.current.length);

  return { level: weight >= 3 ? "high" : weight >= 1 ? "medium" : null, reasons };
}
