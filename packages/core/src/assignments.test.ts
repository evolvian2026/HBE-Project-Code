import { describe, expect, it } from "vitest";
import {
  ASSIGNMENT_SLUG_PATTERN,
  lateDays,
  publishProblems,
  repositoryName,
  slugifyAssignment,
  submissionCutoff,
  type PublishCheckInput,
} from "./assignments.ts";
import { formatInZone, utcToZonedLocal, zonedLocalToUtc } from "./time.ts";

describe("time zones", () => {
  it("converts Singapore wall-clock time (UTC+8, no DST)", () => {
    expect(zonedLocalToUtc("2026-10-20T23:59", "Asia/Singapore").toISOString()).toBe("2026-10-20T15:59:00.000Z");
  });
  it("handles DST in both seasons", () => {
    expect(zonedLocalToUtc("2026-07-01T09:00", "Europe/London").toISOString()).toBe("2026-07-01T08:00:00.000Z");
    expect(zonedLocalToUtc("2026-12-01T09:00", "Europe/London").toISOString()).toBe("2026-12-01T09:00:00.000Z");
    expect(zonedLocalToUtc("2026-03-08T12:00", "America/New_York").toISOString()).toBe("2026-03-08T16:00:00.000Z");
  });
  it("round-trips for form inputs", () => {
    const instant = new Date("2026-10-20T15:59:00Z");
    expect(utcToZonedLocal(instant, "Asia/Singapore")).toBe("2026-10-20T23:59");
    expect(formatInZone(instant, "Asia/Singapore")).toMatch(/20 Oct 2026, 11:59\s?pm (SGT|GMT\+8)/i);
  });
  it("rejects malformed input", () => {
    expect(() => zonedLocalToUtc("tomorrow", "Asia/Singapore")).toThrow(RangeError);
  });
});

const ready: PublishCheckInput = {
  status: "draft",
  dueAt: new Date("2026-11-01T00:00:00Z"),
  releaseAt: null,
  templateRepo: "hbe-templates/mern-starter",
  stackProfileStatus: "active",
  courseArchived: false,
  courseInstallation: { suspended: false, deleted: false },
  rubricCriteriaCount: 2,
  weights: { automated: 60, rubric: 25, process: 15 },
  hasGraderSuite: true,
  now: new Date("2026-10-08T00:00:00Z"),
};

describe("publishProblems", () => {
  it("accepts a complete draft", () => {
    expect(publishProblems(ready)).toEqual([]);
  });
  it("lists every problem", () => {
    const problems = publishProblems({
      ...ready,
      status: "published",
      dueAt: new Date("2026-10-01T00:00:00Z"),
      templateRepo: null,
      courseInstallation: null,
      rubricCriteriaCount: 0,
      hasGraderSuite: false,
    });
    expect(problems).toHaveLength(6);
  });
  it("does not need a test suite when automated tests carry no weight", () => {
    expect(publishProblems({ ...ready, hasGraderSuite: false })).toEqual([
      "Choose a hidden test suite, or set the automated tests weight to 0.",
    ]);
    expect(
      publishProblems({ ...ready, hasGraderSuite: false, weights: { automated: 0, rubric: 85, process: 15 } }),
    ).toEqual([]);
  });
  it("does not need rubric criteria when the rubric weight is 0", () => {
    expect(
      publishProblems({ ...ready, rubricCriteriaCount: 0, weights: { automated: 85, rubric: 0, process: 15 } }),
    ).toEqual([]);
  });
});

describe("names", () => {
  it("derives valid assignment slugs and repository names", () => {
    const slug = slugifyAssignment("Todo API — Part 1!");
    expect(slug).toBe("todo-api-part-1");
    expect(ASSIGNMENT_SLUG_PATTERN.test(slug)).toBe(true);
    expect(repositoryName(slug, "OctoCat")).toBe("todo-api-part-1-octocat");
  });
});

describe("deadlines", () => {
  const deadline = new Date("2026-11-01T15:59:00Z");
  const policy = { per_day_percent: 10, max_days: 3, grace_minutes: 15 };
  const at = (minutes: number) => new Date(deadline.getTime() + minutes * 60_000);

  it("fixes the graded commit after the grace period and the late window", () => {
    expect(submissionCutoff(deadline, policy).toISOString()).toBe("2026-11-04T16:14:00.000Z");
    expect(submissionCutoff(deadline, { ...policy, max_days: 0 }).toISOString()).toBe("2026-11-01T16:14:00.000Z");
  });

  it("counts started days late, after the grace period", () => {
    expect(lateDays(at(-60), deadline, policy)).toBe(0);
    expect(lateDays(at(15), deadline, policy)).toBe(0);
    expect(lateDays(at(16), deadline, policy)).toBe(1);
    expect(lateDays(at(24 * 60), deadline, policy)).toBe(1);
    expect(lateDays(at(24 * 60 + 1), deadline, policy)).toBe(2);
    expect(lateDays(at(10 * 24 * 60), deadline, policy)).toBe(3);
  });
});
