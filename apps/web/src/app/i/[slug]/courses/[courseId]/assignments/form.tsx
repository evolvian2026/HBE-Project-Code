"use client";

import { slugifyAssignment, type StageSettings } from "@hbe/core";
import { useActionState, useState, useTransition, type FormEvent } from "react";
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
  profiles: { id: string; label: string; description: string | null }[];
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
            defaultValue={values.stackProfileId}
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
        <div className="mt-4 grid gap-4 border-t border-border pt-4 sm:grid-cols-2">
          <div className="space-y-2 text-sm">
            <span className="font-medium">Stages</span>
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
          <div className="space-y-3 text-sm">
            {(
              [
                ["Lint", "lint", "stageLint", "Lint the code with the stack's linter"],
                ["StudentTests", "student_tests", "stageStudentTests", "Run the student's own tests"],
              ] as const
            ).map(([suffix, key, name, label]) => (
              <div key={key} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <label className="flex items-center gap-2">
                  <input type="checkbox" name={name} defaultChecked={values.stages[key].enabled} />
                  {label}
                </label>
                <label className="flex items-center gap-1 text-muted">
                  worth
                  <input
                    type="number"
                    name={`stage${suffix}Share`}
                    min={0}
                    max={50}
                    defaultValue={values.stages[key].share}
                    aria-label={`${label}: share of the automated score (%)`}
                    className="w-16 rounded-md border border-border bg-surface px-2 py-1 text-sm text-text"
                  />
                  % of the automated score
                </label>
              </div>
            ))}
            <span className="block text-xs text-muted">
              These use the commands the stack profile defines (e.g. <code>npm run lint</code>, <code>npm test</code>).
            </span>
          </div>
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
