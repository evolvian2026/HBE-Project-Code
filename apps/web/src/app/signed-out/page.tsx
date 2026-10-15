import type { Metadata } from "next";
import { SignOutEverywhere } from "./sign-out";

export const metadata: Metadata = { title: "Signing out" };

/** After signing out on an institution's own address: sign out here too (automatically). */
export default function SignedOutPage() {
  return (
    <main id="main" tabIndex={-1} className="mx-auto max-w-md px-4 py-16 text-center">
      <h1 className="text-xl font-semibold">Signing you out</h1>
      <p className="mt-2 text-sm text-muted">You signed out of your institution&apos;s site; finishing here too.</p>
      <SignOutEverywhere />
    </main>
  );
}
