/**
 * Which automated stages an assignment runs (FR-5.2), and what the optional ones are worth.
 * Stored in assignments.stage_settings; missing keys take the defaults.
 *
 * The optional stages (lint, the student's own tests, test coverage, static analysis and
 * Lighthouse) are off by default. Each is worth a share of the automated score when on; a
 * share of 0 shows the results without counting them.
 */
export interface StageSettings {
  /** The stack profile's linter. */
  lint: { enabled: boolean; share: number };
  /** The student's own test suite (the profile's test command). */
  student_tests: { enabled: boolean; share: number };
  /** Line coverage of the student's own tests; full credit at `target` percent. */
  coverage: { enabled: boolean; share: number; target: number };
  /** The platform's security and code quality rules (Semgrep). */
  static_analysis: { enabled: boolean; share: number };
  /** Lighthouse scores of the app's front page; full credit at the targets (0–100). */
  lighthouse: {
    enabled: boolean;
    share: number;
    targets: { performance: number; accessibility: number; best_practices: number };
  };
  /** Hidden HTTP API test stages. */
  api: { enabled: boolean };
  /** Hidden browser (Playwright) test stages. */
  browser: { enabled: boolean };
}

/** The optional stages, in the order the harness runs them. */
export const OPTIONAL_STAGES = ["lint", "student_tests", "coverage", "static_analysis", "lighthouse"] as const;
export type OptionalStage = (typeof OPTIONAL_STAGES)[number];

export const LIGHTHOUSE_CATEGORIES = ["performance", "accessibility", "best_practices"] as const;

export const DEFAULT_STAGE_SETTINGS: StageSettings = {
  lint: { enabled: false, share: 10 },
  student_tests: { enabled: false, share: 10 },
  coverage: { enabled: false, share: 10, target: 80 },
  static_analysis: { enabled: false, share: 10 },
  lighthouse: { enabled: false, share: 10, targets: { performance: 70, accessibility: 90, best_practices: 90 } },
  api: { enabled: true },
  browser: { enabled: true },
};

/** The optional stages together may be worth at most this much of the automated score. */
export const MAX_SHARED_PERCENT = 50;

const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
const clamp = (min: number, max: number) => (v: unknown, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback;
const percent = clamp(0, MAX_SHARED_PERCENT);
const target = clamp(1, 100);

/** Parses stored settings leniently: unknown keys are dropped, missing ones take defaults. */
export function stageSettings(raw: unknown): StageSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, Record<string, unknown> | undefined>;
  const d = DEFAULT_STAGE_SETTINGS;
  const shared = <K extends OptionalStage>(key: K) => ({
    enabled: bool(r[key]?.enabled, d[key].enabled),
    share: percent(r[key]?.share, d[key].share),
  });
  const targets = (r.lighthouse?.targets ?? {}) as Record<string, unknown>;
  return {
    lint: shared("lint"),
    student_tests: shared("student_tests"),
    coverage: { ...shared("coverage"), target: target(r.coverage?.target, d.coverage.target) },
    static_analysis: shared("static_analysis"),
    lighthouse: {
      ...shared("lighthouse"),
      targets: {
        performance: target(targets.performance, d.lighthouse.targets.performance),
        accessibility: target(targets.accessibility, d.lighthouse.targets.accessibility),
        best_practices: target(targets.best_practices, d.lighthouse.targets.best_practices),
      },
    },
    api: { enabled: bool(r.api?.enabled, d.api.enabled) },
    browser: { enabled: bool(r.browser?.enabled, d.browser.enabled) },
  };
}

/** A problem with the settings a teacher entered, or null. */
export function stageSettingsProblem(s: StageSettings): string | null {
  const shared = OPTIONAL_STAGES.reduce((sum, key) => sum + (s[key].enabled ? s[key].share : 0), 0);
  if (shared > MAX_SHARED_PERCENT) {
    return `Lint, the student's tests, coverage, static analysis and Lighthouse can be worth at most ${MAX_SHARED_PERCENT}% of the automated score together.`;
  }
  return null;
}

/** The parts of a stack profile's definition that decide which optional stages it can run. */
export interface ProfileShape {
  stages?: Record<string, unknown>;
  services?: Record<string, unknown>;
}

/**
 * Which optional stages a stack profile can run: lint, the student's tests and coverage need
 * the profile's command for them; static analysis works on any repository; Lighthouse needs a
 * web front end (a service named `frontend`).
 */
export function availableStages(profile: ProfileShape | undefined): Record<OptionalStage, boolean> {
  const defined = (key: string) => Boolean(profile?.stages?.[key]);
  return {
    lint: defined("lint"),
    student_tests: defined("student_tests"),
    coverage: defined("coverage"),
    static_analysis: true,
    lighthouse: Boolean(profile?.services?.frontend),
  };
}

/** What the grader harness gets (inside the stack profile JSON, as `options`). */
export interface HarnessOptions {
  /** Optional stages to run, with their share of the automated score. */
  stages: {
    lint?: { share: number };
    student_tests?: { share: number };
    coverage?: { share: number; target: number };
    static_analysis?: { share: number };
    lighthouse?: { share: number; targets: StageSettings["lighthouse"]["targets"] };
  };
  /** Kinds of hidden-test stages to skip. */
  skip_kinds: ("api" | "browser")[];
}

/** Optional stages run only if the assignment enables them and the profile can run them. */
export function harnessOptions(settings: StageSettings, profile: ProfileShape | undefined): HarnessOptions {
  const can = availableStages(profile);
  const on = (key: OptionalStage) => settings[key].enabled && can[key];
  const stages: HarnessOptions["stages"] = {};
  if (on("lint")) stages.lint = { share: settings.lint.share };
  if (on("student_tests")) stages.student_tests = { share: settings.student_tests.share };
  if (on("coverage")) stages.coverage = { share: settings.coverage.share, target: settings.coverage.target };
  if (on("static_analysis")) stages.static_analysis = { share: settings.static_analysis.share };
  if (on("lighthouse")) {
    stages.lighthouse = { share: settings.lighthouse.share, targets: { ...settings.lighthouse.targets } };
  }
  const skip_kinds: HarnessOptions["skip_kinds"] = [];
  if (!settings.api.enabled) skip_kinds.push("api");
  if (!settings.browser.enabled) skip_kinds.push("browser");
  return { stages, skip_kinds };
}
