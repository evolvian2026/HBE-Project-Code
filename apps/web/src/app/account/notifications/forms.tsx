"use client";

import { useActionState } from "react";
import { FormStatus } from "@/components/form-status";
import { Button } from "@/components/ui";
import { saveEmailPreferences } from "./actions";
import { EMAIL_TYPES } from "./types";

export function EmailPreferencesForm({ selected }: { selected: string[] }) {
  const [state, action, pending] = useActionState(saveEmailPreferences, null);
  return (
    <form action={action} className="space-y-4">
      <fieldset className="space-y-2 text-sm">
        <legend className="sr-only">Email me about</legend>
        {EMAIL_TYPES.map((t) => (
          <label key={t.type} className="flex items-center gap-2">
            <input type="checkbox" name="types" value={t.type} defaultChecked={selected.includes(t.type)} />
            {t.label}
          </label>
        ))}
      </fieldset>
      <FormStatus state={state} />
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}
