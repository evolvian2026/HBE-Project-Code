"use client";

import { useActionState } from "react";
import { FormStatus } from "@/components/form-status";
import { Button, Field } from "@/components/ui";
import { addStackProfile } from "./actions";

/** A starting point: the shape grader/stacks/*.json uses. */
const EXAMPLE = JSON.stringify(
  {
    detect: ["package.json", "compose.yaml"],
    stages: {
      build: { run: "docker compose build" },
      lint: { image: "node:22-bookworm-slim", setup: "npm ci", run: "npm run lint", report: "text" },
      student_tests: {
        image: "node:22-bookworm-slim",
        setup: "npm ci",
        run: "npm test",
        report: "junit",
        junit: "junit.xml",
      },
      coverage: {
        image: "node:22-bookworm-slim",
        setup: "npm ci",
        run: "node --test --experimental-test-coverage --test-reporter=lcov --test-reporter-destination=lcov.info",
        format: "lcov",
        file: "lcov.info",
        exclude: ["test/**"],
      },
    },
    services: { backend: { port: 4000, health: "/health" } },
    datastores: ["postgres:16"],
    env_required: ["DATABASE_URL"],
    ignore_paths: ["**/node_modules/**", "**/package-lock.json"],
  },
  null,
  2,
);

export function AddStackProfileForm({ slug }: { slug: string }) {
  const [state, action, pending] = useActionState(addStackProfile, null);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="slug" value={slug} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Key"
          name="key"
          required
          pattern="[a-z0-9][a-z0-9-]{1,48}[a-z0-9]"
          placeholder="spring-react"
          hint="Use an existing key of yours to publish its next version."
        />
        <Field
          label="Name"
          name="displayName"
          required
          minLength={2}
          maxLength={100}
          placeholder="Spring Boot + React"
        />
      </div>
      <Field label="Description (optional)" name="description" maxLength={500} />
      <label className="block text-sm">
        <span className="font-medium">Definition (JSON)</span>
        <textarea
          name="definition"
          required
          rows={16}
          defaultValue={EXAMPLE}
          spellCheck={false}
          className="mt-1 block w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs"
        />
        <span className="mt-1 block text-xs text-muted">
          How the grader recognises, builds and starts the app, which services to wait for, and what lint, the
          student&apos;s own tests and their coverage (an lcov or coverage-py report) run. Versions can&apos;t change
          once added: publish a new version instead.
        </span>
      </label>
      <FormStatus state={state} />
      <Button type="submit" disabled={pending}>
        {pending ? "Adding…" : "Add stack profile"}
      </Button>
    </form>
  );
}
