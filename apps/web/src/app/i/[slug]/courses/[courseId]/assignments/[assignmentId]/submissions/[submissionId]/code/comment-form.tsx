"use client";

import { useActionState } from "react";
import { FormStatus } from "@/components/form-status";
import { Button } from "@/components/ui";
import { addReviewComment } from "../../../../actions";

export function CommentForm(props: {
  slug: string;
  courseId: string;
  assignmentId: string;
  submissionId: string;
  sha: string;
  path: string;
  line: number;
}) {
  const [state, action, pending] = useActionState(addReviewComment, null);
  return (
    <form action={action} className="space-y-2 rounded-md border border-border bg-surface p-3 font-sans">
      {Object.entries(props).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={String(value)} />
      ))}
      <label className="block text-sm">
        <span className="font-medium">Your comment on line {props.line}</span>
        <textarea
          name="body"
          rows={3}
          required
          maxLength={5000}
          autoFocus
          className="mt-1 block w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
          placeholder="What should the student change, and why?"
        />
      </label>
      <FormStatus state={state} />
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Add comment"}
      </Button>
    </form>
  );
}
