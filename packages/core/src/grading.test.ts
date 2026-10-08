import { describe, expect, it } from "vitest";
import { computeGrade, type GradeInputs } from "./grading.ts";

const base: GradeInputs = {
  weights: { automated: 60, rubric: 25, process: 15 },
  automated: { score: 70, runId: "run-1" },
  rubric: { points: 16, maxPoints: 20, scored: 2, criteria: 2 },
  process: { score: 80 },
  missing: false,
  lateDays: 0,
  latePolicy: { per_day_percent: 10, max_days: 3, grace_minutes: 15 },
};

describe("computeGrade", () => {
  it("weights each component", () => {
    const g = computeGrade(base);
    // 0.6 × 70 + 0.25 × 80 + 0.15 × 80 = 42 + 20 + 12
    expect(g.raw).toBe(74);
    expect(g.computed).toBe(74);
    expect(g.complete).toBe(true);
    expect(g.components.automated).toEqual({ weight: 60, score: 70, points: 42, runId: "run-1" });
    expect(g.components.rubric).toMatchObject({ score: 80, points: 20, points_awarded: 16, max_points: 20 });
  });

  it("deducts the late penalty from the grade earned", () => {
    const g = computeGrade({ ...base, lateDays: 2 });
    expect(g.latePenalty).toBe(20);
    expect(g.computed).toBe(59.2);
    expect(
      computeGrade({ ...base, lateDays: 20, latePolicy: { ...base.latePolicy, per_day_percent: 50 } }).computed,
    ).toBe(0);
  });

  it("lists what is still missing", () => {
    const g = computeGrade({
      ...base,
      automated: { score: null, runId: null },
      rubric: { points: 8, maxPoints: 20, scored: 1, criteria: 3 },
    });
    expect(g.complete).toBe(false);
    expect(g.pending).toEqual(["the graded test run", "rubric scores for 2 criteria"]);
    expect(g.components.automated.score).toBeNull();
  });

  it("needs nothing for components without weight", () => {
    const g = computeGrade({
      ...base,
      weights: { automated: 0, rubric: 0, process: 100 },
      automated: { score: null, runId: null },
      rubric: { points: 0, maxPoints: 0, scored: 0, criteria: 0 },
    });
    expect(g).toMatchObject({ complete: true, computed: 80 });
  });

  it("scores missing work's tests as 0 without waiting for a run", () => {
    const g = computeGrade({
      ...base,
      missing: true,
      automated: { score: null, runId: null },
      process: { score: null },
    });
    expect(g.complete).toBe(true);
    expect(g.components.automated.score).toBe(0);
    expect(g.computed).toBe(20); // the rubric still counts
  });
});
