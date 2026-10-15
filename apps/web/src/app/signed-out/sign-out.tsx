"use client";

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui";

/** Submits the platform's sign-out at once; the button is there if scripts don't run. */
export function SignOutEverywhere() {
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => form.current?.requestSubmit(), []);
  return (
    <form ref={form} action="/auth/signout" method="post" className="mt-6">
      <Button type="submit">Sign out</Button>
    </form>
  );
}
