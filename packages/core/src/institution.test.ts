import { describe, expect, it } from "vitest";
import { DEFAULT_ASSIGNMENT_DEFAULTS, effectiveLimits, institutionLimits, institutionSettings } from "./institution.ts";

describe("institution settings", () => {
  it("fill in defaults and drop what isn't valid", () => {
    expect(institutionSettings(null)).toEqual({
      assignment_defaults: DEFAULT_ASSIGNMENT_DEFAULTS,
      hidden_stack_profiles: [],
    });
    const id = "aaaaaaaa-0000-4000-8000-000000000001";
    expect(institutionSettings({ hidden_stack_profiles: [id, id, "nope", 3] }).hidden_stack_profiles).toEqual([id]);
    const s = institutionSettings({
      assignment_defaults: {
        run_quota_per_day: 3,
        weights: { automated: 50, rubric: 30, process: 30 }, // doesn't add up to 100
        late_policy: { per_day_percent: 20, max_days: 2, grace_minutes: -1 },
        triggers: { on_push: false },
        post_feedback_to_github: true,
        unknown: 1,
      },
    });
    expect(s.assignment_defaults).toEqual({
      ...DEFAULT_ASSIGNMENT_DEFAULTS,
      run_quota_per_day: 3,
      late_policy: { per_day_percent: 20, max_days: 2, grace_minutes: 15 },
      triggers: { on_push: false, on_pull_request: true, manual: true },
      post_feedback_to_github: true,
    });
  });

  it("limits only tighten the plan", () => {
    const plan = { institution_concurrency: 4, monthly_runner_minutes_budget: 30_000 };
    expect(effectiveLimits(plan, institutionLimits({}))).toEqual({
      maxActiveStudents: null,
      concurrency: 4,
      monthlyRunnerMinutes: 30_000,
    });
    expect(
      effectiveLimits(
        plan,
        institutionLimits({ max_active_students: 120, institution_concurrency: 10, monthly_runner_minutes: 5000 }),
      ),
    ).toEqual({ maxActiveStudents: 120, concurrency: 4, monthlyRunnerMinutes: 5000 });
    expect(institutionLimits({ max_active_students: 0, institution_concurrency: "2" })).toEqual({});
  });
});
