"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui";
import { decideErasure, eraseMember } from "./erasure-actions";

const inputClass = "mt-1 block w-full rounded-md border border-border bg-surface px-3 py-2 text-sm";

type Mode = "anonymise" | "delete";

/**
 * Anonymise or delete. Held in state: React resets a form after its action runs, and a reset
 * after a refused attempt mustn't quietly turn "delete" back into the default.
 */
function ModeChoice({ name = "mode" }: { name?: string }) {
  const [mode, setMode] = useState<Mode>("anonymise");
  return (
    <fieldset className="space-y-2 text-sm">
      <legend className="font-medium">How</legend>
      <label className="flex gap-2">
        <input
          type="radio"
          name={name}
          value="anonymise"
          checked={mode === "anonymise"}
          onChange={() => setMode("anonymise")}
          className="mt-1"
        />
        <span>
          <span className="font-medium">Anonymise</span>: keep their records (grades, reports, feedback, test results,
          source snapshots) under a pseudonym, and remove everything that identifies them.
        </span>
      </label>
      <label className="flex gap-2">
        <input
          type="radio"
          name={name}
          value="delete"
          checked={mode === "delete"}
          onChange={() => setMode("delete")}
          className="mt-1"
        />
        <span>
          <span className="font-medium">Delete</span>: also delete their own records and files. Work shared with a team
          stays, under the pseudonym.
        </span>
      </label>
    </fieldset>
  );
}

/** Erase a member's personal data (an admin acting on a request made outside the platform). */
export function EraseMemberForm({ slug, userId, name }: { slug: string; userId: string; name: string }) {
  const [state, action, pending] = useActionState(eraseMember, null);
  return (
    <details className="w-full text-sm">
      <summary className="cursor-pointer text-danger">Erase personal data…</summary>
      <form
        action={action}
        className="mt-3 space-y-3 rounded-md border border-border p-3"
        aria-label={`Erase ${name}'s personal data`}
      >
        <input type="hidden" name="slug" value={slug} />
        <input type="hidden" name="userId" value={userId} />
        <ModeChoice />
        <label className="block">
          <span className="font-medium">Reason (optional, for the record)</span>
          <input name="note" maxLength={2000} className={inputClass} />
        </label>
        <label className="block">
          <span className="font-medium">Type ERASE to confirm</span>
          <input
            name="confirm"
            required
            pattern="[Ee][Rr][Aa][Ss][Ee]"
            title="Type ERASE"
            autoComplete="off"
            className={inputClass}
          />
        </label>
        <p className="text-muted">
          This can&apos;t be undone. Their account is deleted too unless they belong to another institution.
        </p>
        <Button type="submit" variant="danger" disabled={pending}>
          Erase personal data
        </Button>
        {state && <p className={state.ok ? "text-success" : "text-danger"}>{state.message}</p>}
      </form>
    </details>
  );
}

/** Decide on someone's request (or retry one that failed, the way it was started). */
export function DecideErasureForm({
  slug,
  requestId,
  retryAs,
}: {
  slug: string;
  requestId: string;
  retryAs?: "anonymise" | "delete";
}) {
  const [state, action, pending] = useActionState(decideErasure, null);
  if (retryAs) {
    return (
      <form action={action} className="flex flex-wrap items-center gap-2 text-sm">
        <input type="hidden" name="slug" value={slug} />
        <input type="hidden" name="requestId" value={requestId} />
        <input type="hidden" name="decision" value={retryAs} />
        <Button type="submit" variant="secondary" disabled={pending} className="px-2.5 py-1">
          Try again
        </Button>
        {state && <span className={state.ok ? "text-success" : "text-danger"}>{state.message}</span>}
      </form>
    );
  }
  return (
    <form action={action} className="mt-2 space-y-3 text-sm" aria-label="Decide on the request">
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="requestId" value={requestId} />
      <ModeChoice name="decision" />
      <label className="block">
        <span className="font-medium">Note (told to them if you decline)</span>
        <input name="note" maxLength={2000} className={inputClass} />
      </label>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="danger" disabled={pending}>
          Erase their data
        </Button>
        <Button type="submit" name="decision" value="reject" variant="secondary" disabled={pending}>
          Decline
        </Button>
      </div>
      {state && <p className={state.ok ? "text-success" : "text-danger"}>{state.message}</p>}
    </form>
  );
}
