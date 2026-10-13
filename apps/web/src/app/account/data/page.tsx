import type { Metadata } from "next";
import { AccountNav } from "@/components/account-nav";
import { AppShell, PageTitle } from "@/components/app-shell";
import { Badge, Card, EmptyState } from "@/components/ui";
import { requireSession } from "@/lib/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { AskErasureForm } from "./forms";

export const metadata: Metadata = { title: "Your data" };

const STATUS = {
  requested: "waiting for the admins",
  approved: "being erased",
  running: "being erased",
  failed: "being erased",
  rejected: "declined",
} as const;

export default async function YourDataPage() {
  const session = await requireSession();
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("erasure_requests")
    .select("id, institution_id, status, decision_note, created_at")
    .eq("subject_id", session.userId)
    .order("created_at", { ascending: false });
  const requests = (data ?? []) as {
    id: string;
    institution_id: string;
    status: keyof typeof STATUS;
    decision_note: string | null;
    created_at: string;
  }[];

  return (
    <AppShell session={session}>
      <PageTitle title="Your data" subtitle={session.email ?? undefined} />
      <AccountNav current="/account/data" />
      <div className="max-w-2xl space-y-6">
        <Card
          title="Erasing your personal data"
          description="Each institution you belong to decides what happens to your data there (it is the data controller under the PDPA)."
        >
          <p className="mb-4 text-sm text-muted">
            An institution can anonymise you, keeping your grades and grade reports under a pseudonym (it may have to
            keep academic records), or delete your records. Either way, your name, email, GitHub account and student ID
            are removed. Once you belong to no institution, your account is deleted too.
          </p>
          {session.memberships.length === 0 ? (
            <EmptyState title="You don't belong to any institution" />
          ) : (
            <ul className="divide-y divide-border">
              {session.memberships.map((m) => {
                const open = requests.find((r) => r.institution_id === m.institution.id && r.status !== "rejected");
                const declined = requests.find((r) => r.institution_id === m.institution.id && r.status === "rejected");
                return (
                  <li key={m.institution.id} className="space-y-2 py-3 text-sm">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{m.institution.name}</span>
                      {open && <Badge tone="warning">{STATUS[open.status]}</Badge>}
                    </p>
                    {declined && !open && (
                      <p className="text-muted">
                        Your request of {new Date(declined.created_at).toLocaleDateString("en-SG")} was declined
                        {declined.decision_note ? `: ${declined.decision_note}` : "."}
                      </p>
                    )}
                    {!open && <AskErasureForm institutionId={m.institution.id} name={m.institution.name} />}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
    </AppShell>
  );
}
