import type { Metadata } from "next";
import { AppShell, PageTitle } from "@/components/app-shell";
import { Alert, Badge, Button, Card } from "@/components/ui";
import { safeNext } from "@/lib/config";
import { getMfaState } from "@/lib/mfa";
import { requireSession } from "@/lib/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { removeFactor } from "./actions";
import { EnrollAuthenticator } from "./forms";

export const metadata: Metadata = { title: "Account security" };

export default async function SecurityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const [session, query, mfa] = await Promise.all([requireSession(), searchParams, getMfaState()]);
  const supabase = await createSupabaseServerClient();
  const { data: factors } = await supabase.auth.mfa.listFactors();
  const verified = (factors?.totp ?? []).filter((f) => f.status === "verified");
  const isAdmin = session.isSuperAdmin || session.memberships.some((m) => m.role === "admin");

  return (
    <AppShell session={session}>
      <PageTitle title="Account security" subtitle={session.email ?? undefined} />
      <div className="max-w-2xl space-y-6">
        {query.setup === "required" && (
          <Alert tone="info">Admins must use two-factor authentication. Set up an authenticator app to continue.</Alert>
        )}
        {query.enabled && <Alert tone="success">Two-factor authentication is on.</Alert>}
        {query.removed && <Alert tone="success">Authenticator removed.</Alert>}
        {query.error && <Alert tone="error">{query.error}</Alert>}

        <Card
          title="Two-factor authentication"
          description={
            isAdmin && mfa.required
              ? "Required for your account because you are an admin."
              : "Optional, and recommended."
          }
          actions={verified.length > 0 ? <Badge tone="success">on</Badge> : <Badge tone="warning">off</Badge>}
        >
          {verified.length > 0 ? (
            <ul className="divide-y divide-border">
              {verified.map((f) => (
                <li key={f.id} className="flex items-center justify-between py-2 text-sm">
                  <span>Authenticator app · added {new Date(f.created_at).toLocaleDateString("en-SG")}</span>
                  <form action={removeFactor}>
                    <input type="hidden" name="factorId" value={f.id} />
                    <Button type="submit" variant="secondary" className="px-2.5 py-1">
                      Remove
                    </Button>
                  </form>
                </li>
              ))}
            </ul>
          ) : (
            <EnrollAuthenticator next={safeNext(query.next)} />
          )}
        </Card>
      </div>
    </AppShell>
  );
}
