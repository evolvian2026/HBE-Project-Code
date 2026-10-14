import { describe, expect, it } from "vitest";
import {
  availableStages,
  DEFAULT_STAGE_SETTINGS,
  harnessOptions,
  stageSettings,
  stageSettingsProblem,
} from "./stages.ts";

describe("stage settings", () => {
  it("fill in defaults and clamp shares and targets", () => {
    expect(stageSettings(null)).toEqual(DEFAULT_STAGE_SETTINGS);
    expect(
      stageSettings({
        lint: { enabled: true, share: 80 },
        browser: { enabled: "yes" },
        coverage: { enabled: true, target: 140 },
        lighthouse: { targets: { performance: 0, accessibility: 95.4 } },
        extra: 1,
      }),
    ).toEqual({
      ...DEFAULT_STAGE_SETTINGS,
      lint: { enabled: true, share: 50 },
      coverage: { enabled: true, share: 10, target: 100 },
      lighthouse: { enabled: false, share: 10, targets: { performance: 1, accessibility: 95, best_practices: 90 } },
    });
  });

  it("cap what the optional stages are worth together", () => {
    const s = stageSettings({
      lint: { enabled: true, share: 20 },
      student_tests: { enabled: true, share: 20 },
      static_analysis: { enabled: true, share: 15 },
    });
    expect(stageSettingsProblem(s)).toMatch(/at most 50%/);
    expect(stageSettingsProblem({ ...s, student_tests: { enabled: false, share: 20 } })).toBeNull();
  });

  it("know which optional stages a profile can run", () => {
    expect(availableStages({ stages: { lint: {}, coverage: {} }, services: { backend: {} } })).toEqual({
      lint: true,
      student_tests: false,
      coverage: true,
      static_analysis: true,
      lighthouse: false,
    });
    expect(availableStages({ services: { backend: {}, frontend: {} } }).lighthouse).toBe(true);
  });

  it("tell the harness what to run, only where the profile can", () => {
    const s = stageSettings({
      lint: { enabled: true, share: 10 },
      student_tests: { enabled: true, share: 15 },
      coverage: { enabled: true, share: 5, target: 70 },
      static_analysis: { enabled: true, share: 0 },
      lighthouse: { enabled: true, share: 10 },
      browser: { enabled: false },
    });
    expect(
      harnessOptions(s, { stages: { build: {}, lint: { run: "npm run lint" } }, services: { backend: {} } }),
    ).toEqual({
      stages: { lint: { share: 10 }, static_analysis: { share: 0 } },
      skip_kinds: ["browser"],
    });
    expect(harnessOptions(s, { stages: { coverage: { run: "x" } }, services: { frontend: {} } }).stages).toEqual({
      coverage: { share: 5, target: 70 },
      static_analysis: { share: 0 },
      lighthouse: { share: 10, targets: { performance: 70, accessibility: 90, best_practices: 90 } },
    });
    expect(harnessOptions(DEFAULT_STAGE_SETTINGS, undefined)).toEqual({ stages: {}, skip_kinds: [] });
  });
});
