"use client";

import { useActionState } from "react";
import { FormStatus } from "@/components/form-status";
import { Button, Field } from "@/components/ui";
import { addCriterion, publishAssignment, releaseAssignmentGrades, rerunAssignment, startRun } from "../actions";

type Ids = { slug: string; courseId: string; assignmentId: string };

function Hidden({ slug, courseId, assignmentId }: Ids) {
  return (
    <>
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="courseId" value={courseId} />
      <input type="hidden" name="assignmentId" value={assignmentId} />
    </>
  );
}

export function PublishForm(ids: Ids) {
  const [state, action, pending] = useActionState(publishAssignment, null);
  return (
    <form action={action} className="space-y-3">
      <Hidden {...ids} />
      <FormStatus state={state} />
      {!state?.ok && (
        <Button type="submit" disabled={pending}>
          {pending ? "Publishing…" : "Publish to students"}
        </Button>
      )}
    </form>
  );
}

export function CriterionForm(ids: Ids) {
  const [state, action, pending] = useActionState(addCriterion, null);
  return (
    <form action={action} className="space-y-3">
      <Hidden {...ids} />
      <div className="grid gap-3 sm:grid-cols-4">
        <div className="sm:col-span-3">
          <Field label="Criterion" name="title" required maxLength={200} placeholder="Code quality and structure" />
        </div>
        <Field
          label="Points"
          name="maxPoints"
          type="number"
          min={0.5}
          step={0.5}
          max={1000}
          required
          defaultValue={10}
        />
      </div>
      <Field
        label="What earns full marks (optional)"
        name="description"
        maxLength={2000}
        placeholder="Clear modules, no duplication, meaningful names"
      />
      <FormStatus state={state} />
      <Button type="submit" variant="secondary" disabled={pending}>
        Add criterion
      </Button>
    </form>
  );
}

export function RunTestsForm({ submissionId, disabled, ...ids }: Ids & { submissionId: string; disabled?: boolean }) {
  const [state, action, pending] = useActionState(startRun, null);
  return (
    <form action={action} className="space-y-3">
      <Hidden {...ids} />
      <input type="hidden" name="submissionId" value={submissionId} />
      <Button type="submit" disabled={pending || disabled}>
        {pending ? "Starting…" : "Run tests"}
      </Button>
      <FormStatus state={state} />
    </form>
  );
}

export function ReleaseGradesForm({ disabled, ...ids }: Ids & { disabled: boolean }) {
  const [state, action, pending] = useActionState(releaseAssignmentGrades, null);
  return (
    <form action={action} className="space-y-3">
      <Hidden {...ids} />
      <p className="text-sm text-muted">
        Students see their grade, rubric scores and feedback once released. Changes after that make a new version, which
        students see at once.
      </p>
      <FormStatus state={state} />
      <Button type="submit" disabled={pending || disabled}>
        {pending ? "Releasing…" : "Release grades"}
      </Button>
    </form>
  );
}

/** Instructors: re-run every submission's tests (or the untested ones), with a chosen suite version. */
export function RerunForm({
  suites,
  currentSuiteId,
  ...ids
}: Ids & { suites: { id: string; label: string }[]; currentSuiteId: string }) {
  const [state, action, pending] = useActionState(rerunAssignment, null);
  return (
    <form action={action} className="space-y-3 text-sm">
      <Hidden {...ids} />
      <label className="block">
        <span className="mb-1 block font-medium">Test suite version</span>
        <select
          name="suiteId"
          defaultValue={currentSuiteId}
          className="w-full rounded-md border border-border bg-surface px-2 py-1.5"
        >
          {suites.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
              {s.id === currentSuiteId ? " (current)" : ""}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2">
        <input type="checkbox" name="useForAssignment" />
        Use this version for the assignment&apos;s future runs too
      </label>
      <fieldset className="space-y-1">
        <legend className="mb-1 font-medium">Which submissions</legend>
        <label className="flex items-center gap-2">
          <input type="radio" name="scope" value="all" defaultChecked />
          Every submission
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name="scope" value="unfinished" />
          Only those without a finished run of their commit with this version
        </label>
      </fieldset>
      <FormStatus state={state} />
      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? "Queueing…" : "Re-run tests"}
      </Button>
    </form>
  );
}
