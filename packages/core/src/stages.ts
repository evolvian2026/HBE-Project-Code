/**
 * Which automated stages an assignment runs (FR-5.2), and what lint and the student's own
 * tests are worth. Stored in assignments.stage_settings; missing keys take the defaults.
 */
export interface StageSettings {
  /** The stack profile's linter. */
  lint: { enabled: boolean; share: number };
  /** The student's own test suite (the profile's test command). */
  student_tests: { enabled: boolean; share: number };
  /** Hidden HTTP API test stages. */
  api: { enabled: boolean };
  /** Hidden browser (Playwright) test stages. */
  browser: { enabled: boolean };
}

export const DEFAULT_STAGE_SETTINGS: StageSettings = {
  lint: { enabled: false, share: 10 },
  student_tests: { enabled: false, share: 10 },
  api: { enabled: true },
  browser: { enabled: true },
};

/** Lint and the student's tests together may be worth at most this much of the automated score. */
export const MAX_SHARED_PERCENT = 50;

const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
const percent = (v: unknown, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(MAX_SHARED_PERCENT, Math.max(0, Math.round(v))) : fallback;

/** Parses stored settings leniently: unknown keys are dropped, missing ones take defaults. */
export function stageSettings(raw: unknown): StageSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, Record<string, unknown> | undefined>;
  const d = DEFAULT_STAGE_SETTINGS;
  return {
    lint: { enabled: bool(r.lint?.enabled, d.lint.enabled), share: percent(r.lint?.share, d.lint.share) },
    student_tests: {
      enabled: bool(r.student_tests?.enabled, d.student_tests.enabled),
      share: percent(r.student_tests?.share, d.student_tests.share),
    },
    api: { enabled: bool(r.api?.enabled, d.api.enabled) },
    browser: { enabled: bool(r.browser?.enabled, d.browser.enabled) },
  };
}

/** A problem with the settings a teacher entered, or null. */
export function stageSettingsProblem(s: StageSettings): string | null {
  const shared = (s.lint.enabled ? s.lint.share : 0) + (s.student_tests.enabled ? s.student_tests.share : 0);
  if (shared > MAX_SHARED_PERCENT) {
    return `Lint and the student's own tests can be worth at most ${MAX_SHARED_PERCENT}% of the automated score together.`;
  }
  return null;
}

/** What the grader harness gets (inside the stack profile JSON, as `options`). */
export interface HarnessOptions {
  /** Profile stages to run, with their share of the automated score. */
  stages: Partial<Record<"lint" | "student_tests", { share: number }>>;
  /** Kinds of hidden-test stages to skip. */
  skip_kinds: ("api" | "browser")[];
}

/** Profile stages run only if the assignment enables them and the profile defines them. */
export function harnessOptions(
  settings: StageSettings,
  profileStages: Record<string, unknown> | undefined,
): HarnessOptions {
  const stages: HarnessOptions["stages"] = {};
  for (const key of ["lint", "student_tests"] as const) {
    if (settings[key].enabled && profileStages?.[key]) stages[key] = { share: settings[key].share };
  }
  const skip_kinds: HarnessOptions["skip_kinds"] = [];
  if (!settings.api.enabled) skip_kinds.push("api");
  if (!settings.browser.enabled) skip_kinds.push("browser");
  return { stages, skip_kinds };
}
