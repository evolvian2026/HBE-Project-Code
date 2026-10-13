/**
 * An institution's settings (chosen by its admins, in institutions.settings) and limits (set
 * by the platform operator, in institutions.limits). Stored values are read leniently: unknown
 * keys are dropped and missing or invalid ones take the defaults. The api validates input.
 */

/** What a new assignment starts with in this institution (teachers can change each one). */
export interface AssignmentDefaults {
  run_quota_per_day: number;
  weights: { automated: number; rubric: number; process: number };
  late_policy: { per_day_percent: number; max_days: number; grace_minutes: number };
  regrade_window_days: number;
  triggers: { on_push: boolean; on_pull_request: boolean; manual: boolean };
  post_feedback_to_github: boolean;
}

export interface InstitutionSettings {
  assignment_defaults: AssignmentDefaults;
}

export const DEFAULT_ASSIGNMENT_DEFAULTS: AssignmentDefaults = {
  run_quota_per_day: 5,
  weights: { automated: 60, rubric: 25, process: 15 },
  late_policy: { per_day_percent: 10, max_days: 5, grace_minutes: 15 },
  regrade_window_days: 7,
  triggers: { on_push: true, on_pull_request: true, manual: true },
  post_feedback_to_github: false,
};

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
const intIn = (v: unknown, min: number, max: number, fallback: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : fallback;

export function institutionSettings(raw: unknown): InstitutionSettings {
  const a = obj(obj(raw).assignment_defaults);
  const d = DEFAULT_ASSIGNMENT_DEFAULTS;
  const w = obj(a.weights);
  const weights = {
    automated: intIn(w.automated, 0, 100, -1),
    rubric: intIn(w.rubric, 0, 100, -1),
    process: intIn(w.process, 0, 100, -1),
  };
  const late = obj(a.late_policy);
  const triggers = obj(a.triggers);
  return {
    assignment_defaults: {
      run_quota_per_day: intIn(a.run_quota_per_day, 0, 100, d.run_quota_per_day),
      weights: weights.automated + weights.rubric + weights.process === 100 ? weights : d.weights,
      late_policy: {
        per_day_percent: intIn(late.per_day_percent, 0, 100, d.late_policy.per_day_percent),
        max_days: intIn(late.max_days, 0, 60, d.late_policy.max_days),
        grace_minutes: intIn(late.grace_minutes, 0, 1440, d.late_policy.grace_minutes),
      },
      regrade_window_days: intIn(a.regrade_window_days, 0, 60, d.regrade_window_days),
      triggers: {
        on_push: bool(triggers.on_push, d.triggers.on_push),
        on_pull_request: bool(triggers.on_pull_request, d.triggers.on_pull_request),
        manual: bool(triggers.manual, d.triggers.manual),
      },
      post_feedback_to_github: bool(a.post_feedback_to_github, d.post_feedback_to_github),
    },
  };
}

/** What the platform operator allows this institution; unset means the deployment plan's value. */
export interface InstitutionLimits {
  max_active_students?: number;
  institution_concurrency?: number;
  monthly_runner_minutes?: number;
}

export function institutionLimits(raw: unknown): InstitutionLimits {
  const r = obj(raw);
  const out: InstitutionLimits = {};
  const students = intIn(r.max_active_students, 1, 100_000, 0);
  const concurrency = intIn(r.institution_concurrency, 1, 1000, 0);
  const minutes = intIn(r.monthly_runner_minutes, 1, 10_000_000, 0);
  if (students) out.max_active_students = students;
  if (concurrency) out.institution_concurrency = concurrency;
  if (minutes) out.monthly_runner_minutes = minutes;
  return out;
}

/** The limits that apply: the institution's, never above the plan's (config/profiles). */
export function effectiveLimits(
  plan: { institution_concurrency: number; monthly_runner_minutes_budget: number },
  limits: InstitutionLimits,
): { maxActiveStudents: number | null; concurrency: number; monthlyRunnerMinutes: number } {
  return {
    maxActiveStudents: limits.max_active_students ?? null,
    concurrency: Math.min(plan.institution_concurrency, limits.institution_concurrency ?? Infinity),
    monthlyRunnerMinutes: Math.min(plan.monthly_runner_minutes_budget, limits.monthly_runner_minutes ?? Infinity),
  };
}
