"use client";

import { useActionState } from "react";
import { FormStatus } from "@/components/form-status";
import { Alert, Button, Field } from "@/components/ui";
import { createConnection, createRegistrationLink } from "./actions";

const selectClass = "mt-1 block w-full rounded-md border border-border bg-surface px-3 py-2 text-sm";

function TypeSelect() {
  return (
    <label className="block text-sm">
      <span className="font-medium">LMS</span>
      <select name="type" defaultValue="canvas" className={selectClass}>
        <option value="canvas">Canvas</option>
        <option value="moodle">Moodle</option>
        <option value="lti">Other LTI 1.3 platform</option>
      </select>
    </label>
  );
}

export function RegistrationLinkForm({ slug }: { slug: string }) {
  const [state, action, pending] = useActionState(createRegistrationLink, null);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="slug" value={slug} />
      <div className="grid gap-3 sm:grid-cols-2">
        <TypeSelect />
        <Field label="Name" name="name" required placeholder="Canvas (production)" autoComplete="off" />
      </div>
      {state?.ok && state.url ? (
        <Alert tone="success">
          <p>{state.message}</p>
          <label className="mt-2 block text-xs font-medium" htmlFor="registration-url">
            Registration URL
          </label>
          <input
            id="registration-url"
            readOnly
            value={state.url}
            onFocus={(e) => e.currentTarget.select()}
            className="mt-1 block w-full rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-xs"
          />
        </Alert>
      ) : (
        <FormStatus state={state} />
      )}
      <Button type="submit" disabled={pending}>
        {pending ? "Creating…" : "Create a registration URL"}
      </Button>
    </form>
  );
}

export function ManualConnectionForm({ slug }: { slug: string }) {
  const [state, action, pending] = useActionState(createConnection, null);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="slug" value={slug} />
      <div className="grid gap-3 sm:grid-cols-2">
        <TypeSelect />
        <Field label="Name" name="name" required placeholder="Moodle" autoComplete="off" />
        <Field
          label="Issuer (platform ID)"
          name="issuer"
          required
          placeholder="https://canvas.instructure.com"
          autoComplete="off"
        />
        <Field label="Client ID" name="clientId" required autoComplete="off" />
        <Field
          label="Deployment IDs"
          name="deploymentIds"
          hint="Separate several with commas. Leave empty to accept any deployment of this client."
          autoComplete="off"
        />
        <Field label="Authentication request URL" name="authLoginUrl" required autoComplete="off" />
        <Field label="Access token URL" name="authTokenUrl" required autoComplete="off" />
        <Field label="Public keyset (JWKS) URL" name="jwksUrl" required autoComplete="off" />
      </div>
      <FormStatus state={state} />
      <Button type="submit" disabled={pending}>
        {pending ? "Connecting…" : "Add connection"}
      </Button>
    </form>
  );
}
