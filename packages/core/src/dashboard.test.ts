import { describe, expect, it } from "vitest";
import { riskFlags, type RiskInput } from "./dashboard.ts";

const now = new Date("2026-10-10T00:00:00Z");
const days = (n: number) => new Date(now.getTime() + n * 86_400_000);
const base: RiskInput = {
  now,
  deadline: days(10),
  finalized: false,
  hasRepository: true,
  lastActivityAt: days(-1),
  startedAt: days(-20),
  latestScore: 80,
};

describe("riskFlags", () => {
  it("is quiet for a student who is on track", () => {
    expect(riskFlags(base)).toEqual([]);
  });
  it("flags inactivity", () => {
    expect(riskFlags({ ...base, lastActivityAt: days(-8) })).toEqual(["no activity for 8 days"]);
    expect(riskFlags({ ...base, lastActivityAt: null, startedAt: days(-9) })).toEqual(["no commits in 9 days"]);
    expect(riskFlags({ ...base, lastActivityAt: null, startedAt: days(-2) })).toEqual([]);
  });
  it("flags failing tests only close to the deadline", () => {
    expect(riskFlags({ ...base, latestScore: 30 })).toEqual([]);
    expect(riskFlags({ ...base, latestScore: 30, deadline: days(2) })).toEqual(["tests at 30 with the deadline close"]);
    expect(riskFlags({ ...base, latestScore: null, deadline: days(2) })).toEqual([
      "no test results and the deadline is close",
    ]);
  });
  it("flags a missing repository, and nothing once the deadline has passed", () => {
    expect(riskFlags({ ...base, hasRepository: false, latestScore: null })).toEqual(["no repository yet"]);
    expect(riskFlags({ ...base, deadline: days(-1), latestScore: 0 })).toEqual([]);
    expect(riskFlags({ ...base, finalized: true, latestScore: 0 })).toEqual([]);
  });
});
