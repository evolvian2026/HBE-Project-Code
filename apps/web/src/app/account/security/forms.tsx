"use client";

import { useActionState, useState, useTransition } from "react";
import { Alert, Button, Field } from "@/components/ui";
import { startEnrollment, verifyChallenge, verifyEnrollment, type EnrollState } from "./actions";

export function EnrollAuthenticator({ next }: { next: string }) {
  const [enrollment, setEnrollment] = useState<EnrollState>({ step: "idle" });
  const [starting, startTransition] = useTransition();
  const [error, verify, verifying] = useActionState(verifyEnrollment, null);

  if (enrollment.step === "idle") {
    return (
      <div className="space-y-3">
        {enrollment.error && <Alert tone="error">{enrollment.error}</Alert>}
        <Button
          type="button"
          disabled={starting}
          onClick={() => startTransition(async () => setEnrollment(await startEnrollment()))}
        >
          {starting ? "Starting…" : "Set up authenticator app"}
        </Button>
      </div>
    );
  }

  return (
    <form action={verify} className="space-y-4">
      <input type="hidden" name="next" value={next} />
      <input type="hidden" name="factorId" value={enrollment.factorId} />
      <ol className="list-decimal space-y-3 pl-5 text-sm">
        <li>
          Scan this QR code with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, …).
          <img
            src={enrollment.qrCode}
            alt="QR code for your authenticator app"
            className="mt-2 h-44 w-44 rounded-md bg-white p-2"
          />
          <span className="mt-2 block text-muted">
            Can&apos;t scan it? Enter this key:{" "}
            <code data-testid="totp-secret" className="break-all text-text">
              {enrollment.secret}
            </code>
          </span>
        </li>
        <li>Enter the 6-digit code the app shows.</li>
      </ol>
      <div className="max-w-48">
        <Field
          label="Code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d{6}"
          maxLength={6}
          required
        />
      </div>
      {error && <Alert tone="error">{error}</Alert>}
      <Button type="submit" disabled={verifying}>
        {verifying ? "Checking…" : "Verify and turn on"}
      </Button>
    </form>
  );
}

export function ChallengeForm({ next }: { next: string }) {
  const [error, action, pending] = useActionState(verifyChallenge, null);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="next" value={next} />
      <Field
        label="Code"
        name="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="\d{6}"
        maxLength={6}
        required
        autoFocus
      />
      {error && <Alert tone="error">{error}</Alert>}
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Checking…" : "Continue"}
      </Button>
    </form>
  );
}
