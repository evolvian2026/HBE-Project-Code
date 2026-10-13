"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui";
import { askErasure } from "./actions";

export function AskErasureForm({ institutionId, name }: { institutionId: string; name: string }) {
  const [state, action, pending] = useActionState(askErasure, null);
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-accent">Ask {name} to erase my data…</summary>
      <form action={action} className="mt-2 space-y-2" aria-label={`Ask ${name} to erase my data`}>
        <input type="hidden" name="institutionId" value={institutionId} />
        <label className="block">
          <span className="font-medium">Anything they should know (optional)</span>
          <textarea
            name="note"
            maxLength={2000}
            rows={2}
            className="mt-1 block w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
          />
        </label>
        <Button type="submit" variant="secondary" disabled={pending}>
          Send the request
        </Button>
        {state && <p className={state.ok ? "text-success" : "text-danger"}>{state.message}</p>}
      </form>
    </details>
  );
}
