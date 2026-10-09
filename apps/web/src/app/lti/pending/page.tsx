import type { Metadata } from "next";

export const metadata: Metadata = { title: "Waiting for your admin" };

/** An LMS launch from someone the platform couldn't match to an account (public page). */
export default async function LtiPendingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { institution } = await searchParams;
  const who = institution ? `${institution}'s admin` : "your institution's admin";
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center px-4 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Almost there</h1>
      <p className="mt-3 text-sm">
        We couldn&apos;t match your LMS account to an HBE Projects account, so {who} has been asked to link it.
      </p>
      <p className="mt-2 text-sm text-muted">
        Once they have, open the activity in your LMS again and you&apos;ll go straight in. If you were invited by
        email, make sure your LMS uses the same email address.
      </p>
    </main>
  );
}
