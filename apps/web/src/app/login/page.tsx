import type { Metadata } from "next";
import { Alert, Button, Field } from "@/components/ui";
import { safeNext } from "@/lib/config";
import { sendMagicLink, signInWithGithub } from "./actions";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const next = safeNext(params.next);

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Sign in to HBE Projects</h1>
      <p className="mt-1 text-sm text-muted">Students sign in with GitHub so their work can be linked to them.</p>

      <div className="mt-6 space-y-4">
        {params.error && <Alert tone="error">{params.error}</Alert>}
        {params.sent && <Alert tone="success">Check {params.sent} for a sign-in link.</Alert>}

        <form action={signInWithGithub}>
          <input type="hidden" name="next" value={next} />
          <Button className="w-full" type="submit">
            Continue with GitHub
          </Button>
        </form>

        <div className="flex items-center gap-3 text-xs text-muted">
          <span className="h-px flex-1 bg-border" /> or <span className="h-px flex-1 bg-border" />
        </div>

        <form action={sendMagicLink} className="space-y-3">
          <input type="hidden" name="next" value={next} />
          <Field label="Email" name="email" type="email" autoComplete="email" required placeholder="you@school.edu" />
          <Button className="w-full" variant="secondary" type="submit">
            Email me a sign-in link
          </Button>
        </form>
      </div>
    </main>
  );
}
