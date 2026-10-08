import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ChallengeForm } from "@/app/account/security/forms";
import { safeNext } from "@/lib/config";
import { getMfaState } from "@/lib/mfa";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = { title: "Two-factor authentication" };

export default async function MfaChallengePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const [, query, mfa] = await Promise.all([requireSession(), searchParams, getMfaState()]);
  const next = safeNext(query.next);
  if (mfa.verified) redirect(next);
  if (!mfa.enrolled) redirect(`/account/security?setup=required&next=${encodeURIComponent(next)}`);

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Two-factor authentication</h1>
      <p className="mt-1 mb-6 text-sm text-muted">Enter the 6-digit code from your authenticator app.</p>
      <ChallengeForm next={next} />
    </main>
  );
}
