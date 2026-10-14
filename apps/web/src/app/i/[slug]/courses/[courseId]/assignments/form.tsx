"use client";

import { slugifyAssignment, type OptionalStage, type StageSettings } from "@hbe/core";
import { useActionState, useState, useTransition, type FormEvent, type ReactNode } from "react";
import { FormStatus } from "@/components/form-status";
import { Button, Field } from "@/components/ui";
import { saveAssignment } from "./actions";

export interface AssignmentFormValues {
  id?: string;
  title: string;
  slug: string;
  stackProfileId: string;
  mode: "individual" | "team";
  graderSuiteId: string;
  triggers: { on_push: boolean; on_pull_request: boolean; manual: boolean };
  templateRepo: string;
  dueAt: string;
  releaseAt: string;
  runQuota: number;
  weights: { automated: number; rubric: number; process: number };
  late: { per_day_percent: number; max_days: number; grace_minutes: number };
  regradeWindowDays: number;
  postFeedbackToGithub: boolean;
  stages: StageSettings;
  spec: string;
  published: boolean;
}

const selectClass = "mt-1 block w-full rounded-md border border-border bg-surface px-3 py-2 text-sm";

export function AssignmentForm({
  slug,
  courseId,
  timezone,
  profiles,
  suites,
  values,
}: {
  slug: string;
  courseId: string;
  timezone: string;
  profiles: { id: string; label: string; description: string | null; stages: Record<OptionalStage, boolean> }[];
  suites: { id: string; label: string }[];
  values: AssignmentFormValues;
}) {
  const [state, action, pending] = useActionState(saveAssignment, null);
  const [, startTransition] = useTransition();
  // Dispatch manually: a plain form action would reset every field when validation fails.
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    startTransition(() => action(data));
  };
  const [title, setTitle] = useState(values.title);
  const [shortName, setShortName] = useState(values.slug);
  const [touched, setTouched] = useState(Boolean(values.id));
  const locked = values.published;
  const [profileId, setProfileId] = useState(values.stackProfileId || profiles[0]?.id || "");
  const can = profiles.find((p) => p.id === profileId)?.stages;

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="courseId" value={courseId} />
      <input type="hidden" name="assignmentId" value={values.id ?? ""} />

      <section className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Title"
          name="title"
          required
          maxLength={200}
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            if (!touched) setShortName(slugifyAssignment(e.target.value));
          }}
        />
        <Field
          label="Short name"
          name="assignmentSlug"
          required
          pattern="[a-z0-9][a-z0-9-]{0,38}[a-z0-9]"
          value={shortName}
          readOnly={locked}
          onChange={(e) => {
            setTouched(true);
            setShortName(e.target.value);
          }}
          hint={
            locked
              ? "Locked: student repositories are named after it."
              : "Used in repository names: <short-name>-<github-username> (or <short-name>-<team> for team work)."
          }
        />
        <label className="block text-sm">
          <span className="font-medium">Individual or team work</span>
          <select name="mode" defaultValue={values.mode} className={selectClass} disabled={locked}>
            <option value="individual">Individual: a repository per student</option>
            <option value="team">Team: a repository per team (the course&apos;s teams)</option>
          </select>
          {locked && <input type="hidden" name="mode" value={values.mode} />}
          <span className="mt-1 block text-xs text-muted">
            {locked
              ? "Locked once published."
              : "Team members share a repository and its tests; each keeps their own grade and process score."}
          </span>
        </label>
        <label className="block text-sm">
          <span className="font-medium">Stack profile</span>
          <select
            name="stackProfileId"
            value={profileId}
            onChange={(e) => setProfileId(e.target.value)}
            required
            className={selectClass}
            disabled={locked}
          >
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          {locked && <input type="hidden" name="stackProfileId" value={values.stackProfileId} />}
          <span className="mt-1 block text-xs text-muted">
            {locked ? "Locked once published." : "Fixes the tech stack students use and how it is built and tested."}
          </span>
        </label>
        <Field
          label="Template repository"
          name="templateRepo"
          defaultValue={values.templateRepo}
          placeholder="your-org/mern-starter"
          hint="A GitHub template repository each student's repository is created from."
        />
      </section>

      <fieldset className="rounded-md border border-border p-4">
        <legend className="px-1 text-sm font-medium">Automated tests</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="font-medium">Hidden test suite</span>
            <select name="graderSuiteId" defaultValue={values.graderSuiteId} className={selectClass}>
              <option value="">No automated tests</option>
              {suites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-xs text-muted">
              Black-box tests run against each student&apos;s app. Students see failures, never the test code.
            </span>
          </label>
          <div className="space-y-2 text-sm">
            <span className="font-medium">Run the tests</span>
            {(
              [
                ["onPush", "on_push", "When students push to the default branch"],
                ["onPullRequest", "on_pull_request", "On pull requests"],
                ["manualRuns", "manual", "When students ask (within the daily limit)"],
              ] as const
            ).map(([name, key, label]) => (
              <label key={name} className="flex items-center gap-2">
                <input type="checkbox" name={name} defaultChecked={values.triggers[key]} />
                {label}
              </label>
            ))}
          </div>
        </div>
        <div className="mt-4 border-t border-border pt-4">
          <div className="space-y-2 text-sm">
            <span className="font-medium">Hidden test stages</span>
            <label className="flex items-center gap-2">
              <input type="checkbox" name="stageApi" defaultChecked={values.stages.api.enabled} />
              Hidden API tests
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" name="stageBrowser" defaultChecked={values.stages.browser.enabled} />
              Hidden browser tests
            </label>
            <span className="block text-xs text-muted">Used when the suite has stages of that kind.</span>
          </div>
        </div>
        <div className="mt-4 border-t border-border pt-4 text-sm">
          <span className="font-medium">Optional stages</span>
          <p className="mt-1 text-xs text-muted">
            Each is worth a share of the automated score, together at most 50%; 0% shows the results without counting
            them. Lint, tests and coverage use the stack profile&apos;s commands (e.g. <code>npm run lint</code>,{" "}
            <code>npm test</code>).
          </p>
          <ul className="mt-2 divide-y divide-border">
            <OptionalStageRow
              id="Lint"
              label="Lint the code with the stack's linter"
              setting={values.stages.lint}
              available={can?.lint}
            />
            <OptionalStageRow
              id="StudentTests"
              label="Run the student's own tests"
              setting={values.stages.student_tests}
              available={can?.student_tests}
            />
            <OptionalStageRow
              id="Coverage"
              label="Measure their tests' line coverage"
              setting={values.stages.coverage}
              available={can?.coverage}
            >
              <NumberInput
                name="stageCoverageTarget"
                label="Full credit at"
                suffix="% of lines"
                ariaLabel="Line coverage for full credit (%)"
                min={1}
                max={100}
                defaultValue={values.stages.coverage.target}
              />
            </OptionalStageRow>
            <OptionalStageRow
              id="StaticAnalysis"
              label="Check for security mistakes (static analysis)"
              setting={values.stages.static_analysis}
              available={can?.static_analysis}
            />
            <OptionalStageRow
              id="Lighthouse"
              label="Audit the front page with Lighthouse"
              setting={values.stages.lighthouse}
              available={can?.lighthouse}
              unavailable="Needs a stack with a web front end."
            >
              <span className="flex flex-wrap gap-x-3 gap-y-1">
                <span className="text-muted">Full credit at scores of</span>
                {(
                  [
                    ["stageLighthousePerformance", "performance", "performance"],
                    ["stageLighthouseAccessibility", "accessibility", "accessibility"],
                    ["stageLighthouseBestPractices", "best_practices", "best practices"],
                  ] as const
                ).map(([name, key, label]) => (
                  <NumberInput
                    key={name}
                    name={name}
                    label=""
                    suffix={label}
                    ariaLabel={`Lighthouse ${label} score for full credit`}
                    min={1}
                    max={100}
                    defaultValue={values.stages.lighthouse.targets[key]}
                  />
                ))}
              </span>
            </OptionalStageRow>
          </ul>
        </div>
      </fieldset>

      <section className="grid gap-4 sm:grid-cols-3">
        <Field label={`Due (${timezone})`} name="dueAt" type="datetime-local" required defaultValue={values.dueAt} />
        <Field
          label={`Visible to students from (${timezone})`}
          name="releaseAt"
          type="datetime-local"
          defaultValue={values.releaseAt}
          hint="Optional. Empty means as soon as it is published."
        />
        <Field
          label="Test runs per student per day"
          name="runQuota"
          type="number"
          min={0}
          max={100}
          required
          defaultValue={values.runQuota}
        />
      </section>

      <fieldset className="rounded-md border border-border p-4">
        <legend className="px-1 text-sm font-medium">Grade weights (must add up to 100)</legend>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            label="Automated tests %"
            name="automated"
            type="number"
            min={0}
            max={100}
            required
            defaultValue={values.weights.automated}
          />
          <Field
            label="Rubric %"
            name="rubric"
            type="number"
            min={0}
            max={100}
            required
            defaultValue={values.weights.rubric}
          />
          <Field
            label="Process (activity) %"
            name="process"
            type="number"
            min={0}
            max={100}
            required
            defaultValue={values.weights.process}
          />
        </div>
      </fieldset>

      <fieldset className="rounded-md border border-border p-4">
        <legend className="px-1 text-sm font-medium">Late submissions</legend>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            label="Penalty per day late (%)"
            name="latePerDay"
            type="number"
            min={0}
            max={100}
            required
            defaultValue={values.late.per_day_percent}
          />
          <Field
            label="Accepted for up to (days)"
            name="lateMaxDays"
            type="number"
            min={0}
            max={60}
            required
            defaultValue={values.late.max_days}
          />
          <Field
            label="Grace period (minutes)"
            name="lateGraceMinutes"
            type="number"
            min={0}
            max={1440}
            required
            defaultValue={values.late.grace_minutes}
          />
        </div>
      </fieldset>

      <fieldset className="rounded-md border border-border p-4">
        <legend className="px-1 text-sm font-medium">Regrades</legend>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field
            label="Requests accepted for (days after release)"
            name="regradeWindowDays"
            type="number"
            min={0}
            max={60}
            required
            hint="0 turns regrade requests off."
            defaultValue={values.regradeWindowDays}
          />
        </div>
        <label className="mt-4 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            name="postFeedbackToGithub"
            defaultChecked={values.postFeedbackToGithub}
            className="mt-0.5"
          />
          <span>
            Also post the feedback and code comments to GitHub
            <span className="block text-xs text-muted">
              Once a grade is released, as a &ldquo;Feedback&rdquo; issue in the student&apos;s (or team&apos;s)
              repository, kept up to date. Scores are never posted there.
            </span>
          </span>
        </label>
      </fieldset>

      <label className="block text-sm">
        <span className="font-medium">Specification (Markdown)</span>
        <textarea
          name="spec"
          rows={14}
          defaultValue={values.spec}
          className="mt-1 block w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-sm"
          placeholder={"## Goal\nBuild a todo API with…\n\n## Requirements\n- …"}
        />
      </label>

      <FormStatus state={state} />
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : values.id ? "Save changes" : "Create draft"}
      </Button>
    </form>
  );
}

const numberClass = "w-16 rounded-md border border-border bg-surface px-2 py-1 text-sm text-text";

function NumberInput({
  name,
  label,
  suffix,
  min,
  max,
  defaultValue,
  ariaLabel,
}: {
  name: string;
  label: string;
  suffix: string;
  min: number;
  max: number;
  defaultValue: number;
  ariaLabel: string;
}) {
  return (
    <label className="flex items-center gap-1 text-muted">
      {label}
      <input
        type="number"
        name={name}
        min={min}
        max={max}
        required
        defaultValue={defaultValue}
        aria-label={ariaLabel}
        className={numberClass}
      />
      {suffix}
    </label>
  );
}

/**
 * One optional stage: on or off, what it is worth, and its targets. A stage the stack can't
 * run keeps its values in hidden fields, so switching the stack back doesn't lose them.
 */
function OptionalStageRow({
  id,
  label,
  setting,
  available,
  unavailable = "Not available for this stack profile.",
  children,
}: {
  id: string;
  label: string;
  setting: { enabled: boolean; share: number };
  available: boolean | undefined;
  unavailable?: string;
  children?: ReactNode;
}) {
  const off = available === false;
  return (
    <li className="grid gap-x-6 gap-y-2 py-3 sm:grid-cols-[minmax(0,1fr)_auto]">
      <div className="space-y-2">
        <label className="flex items-center gap-2">
          <input type="checkbox" name={`stage${id}`} defaultChecked={setting.enabled} disabled={off} />
          {label}
        </label>
        {off && <p className="pl-6 text-xs text-muted">{unavailable}</p>}
        {children && (
          <div className="pl-6" hidden={off}>
            {children}
          </div>
        )}
      </div>
      <label className={`${off ? "hidden" : "flex"} items-center gap-1 pl-6 text-muted sm:pl-0`}>
        worth
        <input
          type="number"
          name={`stage${id}Share`}
          min={0}
          max={50}
          required
          defaultValue={setting.share}
          aria-label={`${label}: share of the automated score (%)`}
          className={numberClass}
        />
        % of the automated score
      </label>
    </li>
  );
}
