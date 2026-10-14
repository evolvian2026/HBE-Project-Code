import { describe, expect, it } from "vitest";
import { assessStudentRisk, distribution, median, type FinishedAssignment } from "./analytics.ts";

const done = (over: Partial<FinishedAssignment> = {}): FinishedAssignment => ({
  title: "A1",
  score: 80,
  lateDays: 0,
  missing: false,
  processScore: 70,
  ...over,
});

describe("median and distribution", () => {
  it("handle odd, even and empty sets", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it("puts 100 in the last bin and clamps out-of-range scores", () => {
    const bins = distribution([0, 9.9, 10, 55, 100, 100, -3, 120]);
    expect(bins).toHaveLength(10);
    expect(bins[0]).toEqual({ from: 0, to: 10, count: 3 });
    expect(bins[1]!.count).toBe(1);
    expect(bins[5]!.count).toBe(1);
    expect(bins[9]).toEqual({ from: 90, to: 100, count: 3 });
  });
});

describe("assessStudentRisk", () => {
  it("is quiet for a student doing fine", () => {
    expect(assessStudentRisk({ finished: [done(), done({ title: "A2", score: 75 })], current: [] })).toEqual({
      level: null,
      reasons: [],
    });
  });

  it("weighs missed work and a low average most, and says why", () => {
    const r = assessStudentRisk({
      finished: [done({ score: 40 }), done({ title: "A2", score: null, missing: true })],
      current: [],
    });
    expect(r.level).toBe("high");
    expect(r.reasons).toEqual([
      "nothing submitted for 1 assignment (A2)",
      "average grade 40 over the last 1 assignment",
    ]);
  });

  it("notices a fall in grades, repeated lateness, a low process score and current signals", () => {
    const r = assessStudentRisk({
      finished: [done({ score: 85, lateDays: 1 }), done({ title: "A2", score: 60, lateDays: 2, processScore: 30 })],
      current: ["A3: no activity for 9 days"],
    });
    expect(r.reasons).toEqual([
      "grade fell from 85 to 60 (A2)",
      "late on 2 assignments",
      "process score 30 on A2",
      "A3: no activity for 9 days",
    ]);
    expect(r.level).toBe("high");
  });

  it("is medium for a single signal, and counts at most two current signals", () => {
    expect(assessStudentRisk({ finished: [], current: ["A1: no repository yet"] }).level).toBe("medium");
    expect(assessStudentRisk({ finished: [], current: ["a", "b", "c", "d"] }).level).toBe("medium");
    expect(assessStudentRisk({ finished: [done({ score: 49 }), done({ score: 51 })], current: [] }).level).toBe(null); // average 50
  });
});
