import type { Metadata } from "next";
import { AppShell, PageTitle } from "@/components/app-shell";
import { Card } from "@/components/ui";
import { requireSession } from "@/lib/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { EmailPreferencesForm } from "./forms";

export const metadata: Metadata = { title: "Email notifications" };

export default async function EmailNotificationsPage() {
  const session = await requireSession();
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("profiles")
    .select("email_notification_types")
    .eq("id", session.userId)
    .maybeSingle();

  return (
    <AppShell session={session}>
      <PageTitle title="Email notifications" subtitle={session.email ?? undefined} />
      <div className="max-w-2xl">
        <Card
          title="Email me about"
          description="Everything also appears under Notifications in the app; these choices only affect email."
        >
          {session.email ? (
            <EmailPreferencesForm selected={(data?.email_notification_types as string[] | undefined) ?? []} />
          ) : (
            <p className="text-sm text-muted">Your account has no email address, so there's nothing to send to.</p>
          )}
        </Card>
      </div>
    </AppShell>
  );
}
