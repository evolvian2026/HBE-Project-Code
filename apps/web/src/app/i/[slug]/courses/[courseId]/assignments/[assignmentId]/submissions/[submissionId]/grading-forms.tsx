"use client";

import { useActionState, useTransition, type FormEvent } from "react";
import { FormStatus } from "@/components/form-status";
import { Button, Field } from "@/components/ui";
import { saveOverride, saveReview } from "../../../actions";

type Ids = { slug: string; courseId: string; assignmentId: string; submissionId: string };

function Hidden(ids: Ids) {
  return (
    <>
      {Object.entries(ids).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
    </>
  );
}

/** Dispatches without React's automatic form reset, so typed values survive errors. */
function useFormAction(action: (data: FormData) => void) {
  const [, startTransition] = useTransition();
  return (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    startTransition(() => action(data));
  };
}

export interface CriterionScore {
  id: string;
  title: string;
  description: string | null;
  maxPoints: number;
  points: number | null;
  comment: string | null;
}

export function ReviewForm({ ids, criteria, feedback }: { ids: Ids; criteria: CriterionScore[]; feedback: string }) {
  const [state, action, pending] = useActionState(saveReview, null);
  const onSubmit = useFormAction(action);
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <Hidden {...ids} />
      {criteria.map((c) => (
        <fieldset key={c.id} className="rounded-md border border-border p-3">
          <legend className="px-1 text-sm font-medium">
            {c.title} <span className="font-normal text-muted">(max {c.maxPoints})</span>
          </legend>
          {c.description && <p className="mb-2 text-sm text-muted">{c.description}</p>}
          <div className="grid gap-3 sm:grid-cols-4">
            <Field
              label={`Points for ${c.title}`}
              name={`points:${c.id}`}
              type="number"
              min={0}
              max={c.maxPoints}
              step={0.5}
              defaultValue={c.points ?? ""}
            />
            <label className="block text-sm sm:col-span-3">
              <span className="font-medium">Comment</span>
              <textarea
                name={`comment:${c.id}`}
                rows={2}
                maxLength={5000}
                defaultValue={c.comment ?? ""}
                className="mt-1 block w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
              />
            </label>
          </div>
        </fieldset>
      ))}
      <label className="block text-sm">
        <span className="font-medium">Feedback for the student (Markdown)</span>
        <textarea
          name="feedback"
          rows={6}
          maxLength={50_000}
          defaultValue={feedback}
          className="mt-1 block w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-sm"
          placeholder={"## What went well\n- …\n\n## To improve\n- …"}
        />
        <span className="mt-1 block text-xs text-muted">
          Students see scores and feedback once grades are released.
        </span>
      </label>
      <FormStatus state={state} />
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save review"}
      </Button>
    </form>
  );
}

export function OverrideForm({ ids, current }: { ids: Ids; current: { score: number; reason: string } | null }) {
  const [state, action, pending] = useActionState(saveOverride, null);
  const onSubmit = useFormAction(action);
  const [removeState, removeAction, removing] = useActionState(saveOverride, null);
  const onRemove = useFormAction(removeAction);
  return (
    <div className="space-y-3">
      <form onSubmit={onSubmit} className="space-y-3">
        <Hidden {...ids} />
        <div className="grid gap-3 sm:grid-cols-3">
          <Field
            label="Final grade"
            name="score"
            type="number"
            min={0}
            max={100}
            step={0.5}
            required
            defaultValue={current?.score ?? ""}
          />
          <div className="sm:col-span-2">
            <Field
              label="Reason (staff only)"
              name="reason"
              required
              minLength={5}
              maxLength={1000}
              defaultValue={current?.reason ?? ""}
            />
          </div>
        </div>
        <FormStatus state={state} />
        <Button type="submit" variant="secondary" disabled={pending}>
          {pending ? "Saving…" : current ? "Change override" : "Override grade"}
        </Button>
      </form>
      {current && (
        <form onSubmit={onRemove}>
          <Hidden {...ids} />
          <input type="hidden" name="score" value="" />
          <FormStatus state={removeState} />
          <Button type="submit" variant="secondary" disabled={removing}>
            Remove override
          </Button>
        </form>
      )}
    </div>
  );
}
