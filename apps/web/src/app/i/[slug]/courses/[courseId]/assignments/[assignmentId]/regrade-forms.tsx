"use client";

import { useActionState, useTransition, type FormEvent } from "react";
import { FormStatus } from "@/components/form-status";
import { Button } from "@/components/ui";
import { requestRegrade, resolveRegrade } from "../actions";

type Ids = { slug: string; courseId: string; assignmentId: string; submissionId: string };

const textareaClass = "mt-1 block w-full rounded-md border border-border bg-surface px-3 py-2 text-sm";

function Hidden(values: Record<string, string>) {
  return (
    <>
      {Object.entries(values).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
    </>
  );
}

/** Dispatches without React's automatic form reset, so typed text survives errors. */
function useFormAction(action: (data: FormData) => void) {
  const [, startTransition] = useTransition();
  return (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    startTransition(() => action(data));
  };
}

export function RegradeRequestForm({ ids }: { ids: Ids }) {
  const [state, action, pending] = useActionState(requestRegrade, null);
  const onSubmit = useFormAction(action);
  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <Hidden {...ids} />
      <label className="block text-sm">
        <span className="font-medium">What should be looked at again, and why?</span>
        <textarea
          name="message"
          rows={4}
          required
          minLength={10}
          maxLength={2000}
          className={textareaClass}
          placeholder="e.g. The “search” tests failed, but the spec asks for case-sensitive search, which my code does."
        />
      </label>
      <FormStatus state={state} />
      <Button type="submit" disabled={pending}>
        {pending ? "Sending…" : "Request a regrade"}
      </Button>
    </form>
  );
}

export function ResolveRegradeForm({ ids, requestId }: { ids: Ids; requestId: string }) {
  const [state, action, pending] = useActionState(resolveRegrade, null);
  const onSubmit = useFormAction(action);
  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <Hidden {...ids} requestId={requestId} />
      <fieldset className="flex flex-wrap gap-4 text-sm">
        <legend className="sr-only">Decision</legend>
        <label className="flex items-center gap-2">
          <input type="radio" name="outcome" value="accepted" required /> Accept
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name="outcome" value="declined" /> Decline
        </label>
      </fieldset>
      <label className="block text-sm">
        <span className="font-medium">Response to the student</span>
        <textarea
          name="response"
          rows={3}
          required
          minLength={5}
          maxLength={2000}
          className={textareaClass}
          placeholder="What you decided and why. If you accept, change the rubric scores or override the grade above first."
        />
      </label>
      <FormStatus state={state} />
      <Button type="submit" disabled={pending}>
        {pending ? "Sending…" : "Send response"}
      </Button>
    </form>
  );
}
