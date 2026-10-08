/**
 * At-risk signals for the teacher dashboard (FR-7.2). Flags only: they prompt a conversation,
 * they never change a grade.
 */
export interface RiskInput {
  now: Date;
  /** The student's effective deadline. */
  deadline: Date;
  /** The graded commit is fixed. */
  finalized: boolean;
  hasRepository: boolean;
  /** When the platform last received a commit; null if never. */
  lastActivityAt: Date | null;
  /** When the student's repository was ready (to give new repositories a grace period). */
  startedAt: Date;
  /** Latest finished run's score (0–100), if any. */
  latestScore: number | null;
}

export interface RiskPolicy {
  inactiveDays: number;
  nearDeadlineDays: number;
  failingBelow: number;
}

export const DEFAULT_RISK_POLICY: RiskPolicy = { inactiveDays: 7, nearDeadlineDays: 3, failingBelow: 50 };
const DAY_MS = 86_400_000;

export function riskFlags(input: RiskInput, policy: RiskPolicy = DEFAULT_RISK_POLICY): string[] {
  if (input.finalized || input.deadline <= input.now) return [];
  const flags: string[] = [];
  if (!input.hasRepository) flags.push("no repository yet");
  const since = input.lastActivityAt ?? input.startedAt;
  const idleDays = Math.floor((input.now.getTime() - since.getTime()) / DAY_MS);
  if (input.hasRepository && idleDays >= policy.inactiveDays) {
    flags.push(input.lastActivityAt ? `no activity for ${idleDays} days` : `no commits in ${idleDays} days`);
  }
  const daysLeft = (input.deadline.getTime() - input.now.getTime()) / DAY_MS;
  if (daysLeft <= policy.nearDeadlineDays) {
    if (input.latestScore === null) {
      if (input.hasRepository) flags.push("no test results and the deadline is close");
    } else if (input.latestScore < policy.failingBelow) {
      flags.push(`tests at ${Math.round(input.latestScore)} with the deadline close`);
    }
  }
  return flags;
}
