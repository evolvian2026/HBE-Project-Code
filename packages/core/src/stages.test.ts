import { describe, expect, it } from "vitest";
import { DEFAULT_STAGE_SETTINGS, harnessOptions, stageSettings, stageSettingsProblem } from "./stages.ts";

describe("stage settings", () => {
  it("fill in defaults and clamp shares", () => {
    expect(stageSettings(null)).toEqual(DEFAULT_STAGE_SETTINGS);
    expect(stageSettings({ lint: { enabled: true, share: 80 }, browser: { enabled: "yes" }, extra: 1 })).toEqual({
      ...DEFAULT_STAGE_SETTINGS,
      lint: { enabled: true, share: 50 },
    });
  });

  it("cap what lint and the student's tests are worth together", () => {
    const s = stageSettings({ lint: { enabled: true, share: 30 }, student_tests: { enabled: true, share: 30 } });
    expect(stageSettingsProblem(s)).toMatch(/at most 50%/);
    expect(stageSettingsProblem({ ...s, student_tests: { enabled: false, share: 30 } })).toBeNull();
  });

  it("tell the harness what to run, only where the profile can", () => {
    const s = stageSettings({
      lint: { enabled: true, share: 10 },
      student_tests: { enabled: true, share: 15 },
      browser: { enabled: false },
    });
    expect(harnessOptions(s, { build: {}, lint: { run: "npm run lint" } })).toEqual({
      stages: { lint: { share: 10 } },
      skip_kinds: ["browser"],
    });
    expect(harnessOptions(DEFAULT_STAGE_SETTINGS, undefined)).toEqual({ stages: {}, skip_kinds: [] });
  });
});
