import Link from "next/link";
import { redirect } from "next/navigation";
import { AppShell, PageTitle } from "@/components/app-shell";
import { Badge, ButtonLink, Card, EmptyState, roleTone } from "@/components/ui";
import { requireSession } from "@/lib/session";

export default async function Dashboard() {
  const session = await requireSession();
  const only = session.memberships.length === 1 ? session.memberships[0] : undefined;
  if (only && !session.isSuperAdmin) redirect(`/i/${only.institution.slug}`);

  return (
    <AppShell session={session}>
      <PageTitle
        title={`Welcome${session.fullName ? `, ${session.fullName}` : ""}`}
        subtitle="Choose an institution to continue."
        actions={session.isSuperAdmin && <ButtonLink href="/platform">Platform console</ButtonLink>}
      />
      {session.memberships.length === 0 ? (
        <EmptyState title="You are not a member of any institution yet">
          Ask your institution&apos;s admin to invite {session.email ?? "your email address"}
          {session.githubLogin ? ` or GitHub user @${session.githubLogin}` : ""}, then sign in again.
        </EmptyState>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {session.memberships.map((m) => (
            <Link key={m.institution.id} href={`/i/${m.institution.slug}`} className="group">
              <Card>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="font-medium group-hover:text-accent">{m.institution.name}</p>
                    <p className="text-sm text-muted">{m.institution.slug}</p>
                  </div>
                  <Badge tone={roleTone(m.role)}>{m.role}</Badge>
                </div>
                {m.institution.status !== "active" && (
                  <p className="mt-3">
                    <Badge tone="warning">{m.institution.status.replace("_", " ")}</Badge>
                  </p>
                )}
              </Card>
            </Link>
          ))}
        </div>
      )}
    </AppShell>
  );
}
