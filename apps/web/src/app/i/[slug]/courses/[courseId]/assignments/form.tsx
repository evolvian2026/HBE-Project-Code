"use client";

import { slugifyAssignment } from "@hbe/core";
import { useActionState, useState, useTransition, type FormEvent } from "react";
import { FormStatus } from "@/components/form-status";
import { Button, Field } from "@/components/ui";
import { saveAssignment } from "./actions";

export interface AssignmentFormValues {
  id?: string;
  title: string;
  slug: string;
  stackProfileId: string;
  graderSuiteId: string;
  triggers: { on_push: boolean; on_pull_request: boolean; manual: boolean };
  templateRepo: string;
  dueAt: string;
  releaseAt: string;
  runQuota: number;
  weights: { automated: number; rubric: number; process: number };
  late: { per_day_percent: number; max_days: number; grace_minutes: number };
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
              : "Used in repository names: <short-name>-<github-username>."
          }
        />
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
