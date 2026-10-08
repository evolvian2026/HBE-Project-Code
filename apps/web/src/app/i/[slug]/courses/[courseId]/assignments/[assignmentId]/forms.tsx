"use client";

import { useActionState } from "react";
import { FormStatus } from "@/components/form-status";
import { Button, Field } from "@/components/ui";
import { addCriterion, publishAssignment, startRun } from "../actions";

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
