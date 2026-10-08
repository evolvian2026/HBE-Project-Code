"use client";

import { useActionState, useTransition, type FormEvent } from "react";
import { FormStatus } from "@/components/form-status";
import { Button, Field } from "@/components/ui";
import { removeExtension, saveExtension } from "../../../actions";

/** Grants or changes one student's deadline. Reopens the submission if its cutoff is ahead. */
export function ExtensionForm(props: {
  slug: string;
  courseId: string;
  assignmentId: string;
  submissionId: string;
  studentId: string;
  timezone: string;
  current: string | null;
}) {
  const [state, action, pending] = useActionState(saveExtension, null);
  const [, startTransition] = useTransition();
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    startTransition(() => action(data));
  };
  const hidden = (
    <>
      <input type="hidden" name="slug" value={props.slug} />
      <input type="hidden" name="courseId" value={props.courseId} />
      <input type="hidden" name="assignmentId" value={props.assignmentId} />
      <input type="hidden" name="submissionId" value={props.submissionId} />
      <input type="hidden" name="studentId" value={props.studentId} />
    </>
  );
  return (
    <div className="space-y-3">
      <form onSubmit={onSubmit} className="space-y-3">
        {hidden}
        <Field
          label={`New due date (${props.timezone})`}
          name="dueAt"
          type="datetime-local"
          required
          defaultValue={props.current ?? ""}
        />
        <Field label="Reason" name="reason" maxLength={500} placeholder="Medical certificate" />
        <FormStatus state={state} />
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : props.current ? "Change extension" : "Grant extension"}
        </Button>
      </form>
      {props.current && (
        <form action={removeExtension}>
          {hidden}
          <Button type="submit" variant="secondary">
            Remove extension
          </Button>
        </form>
      )}
    </div>
  );
}
