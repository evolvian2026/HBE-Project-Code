import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell, PageTitle } from "@/components/app-shell";
import { Alert, Badge, Button, Card, EmptyState, roleTone } from "@/components/ui";
import { requireSession } from "@/lib/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { connectGithubOrganisation, linkGithubAccount } from "./actions";

type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
};

const ERRORS: Record<string, string> = {
  github_not_linked: "Link your GitHub account first. GitHub tells us who installed the App, and that must be you.",
  github_link_failed: "Could not start linking your GitHub account. Try again.",
  forbidden: "Only active institution admins can do that.",
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const session = await requireSession();
  const membership = session.memberships.find((m) => m.institution.slug === slug);
  return { title: membership?.institution.name ?? "Institution" };
}

export default async function InstitutionPage({ params, searchParams }: Props) {
  const [{ slug }, query, session] = await Promise.all([params, searchParams, requireSession()]);
  const membership = session.memberships.find((m) => m.institution.slug === slug);
  if (!membership) notFound();

  const { institution, role } = membership;
  const isAdmin = role === "admin";
  const supabase = await createSupabaseServerClient();

  const [courses, installations, members] = await Promise.all([
    supabase
      .from("courses")
      .select("id, code, name, term, archived_at")
      .eq("institution_id", institution.id)
      .order("term", { ascending: false }),
    isAdmin
      ? supabase
          .from("github_installations")
          .select("installation_id, account_login, account_type, suspended_at, deleted_at, linked_at")
          .eq("institution_id", institution.id)
      : Promise.resolve({ data: [] as never[] }),
    isAdmin || role === "teacher"
      ? supabase
          .from("institution_memberships")
          .select("role")
          .eq("institution_id", institution.id)
          .eq("status", "active")
      : Promise.resolve({ data: [] as never[] }),
  ]);

  const counts = { admin: 0, teacher: 0, student: 0 } as Record<string, number>;
  for (const m of members.data ?? []) counts[m.role] = (counts[m.role] ?? 0) + 1;
  const activeInstallations = (installations.data ?? []).filter((i) => !i.deleted_at);

  return (
    <AppShell session={session} current={slug}>
      <PageTitle
        title={institution.name}
        subtitle={
          <span className="inline-flex items-center gap-2">
            You are <Badge tone={roleTone(role)}>{role}</Badge>
            {institution.status !== "active" && <Badge tone="warning">{institution.status.replace("_", " ")}</Badge>}
          </span>
        }
      />

      <div className="space-y-6">
        {query.error && <Alert tone="error">{ERRORS[query.error] ?? query.error}</Alert>}

        {(isAdmin || role === "teacher") && (
          <div className="grid gap-4 sm:grid-cols-3">
            {(["admin", "teacher", "student"] as const).map((r) => (
              <Card key={r}>
                <p className="text-sm text-muted capitalize">{r}s</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">{counts[r] ?? 0}</p>
              </Card>
            ))}
          </div>
        )}

        <Card
          title={role === "student" ? "My courses" : "Courses"}
          description="Projects and evaluations arrive in the next phase."
        >
          {(courses.data ?? []).length === 0 ? (
            <EmptyState title="No courses yet" />
          ) : (
            <ul className="divide-y divide-border">
              {(courses.data ?? []).map((c) => (
                <li key={c.id} className="flex items-center justify-between py-2.5 text-sm">
                  <span>
                    <span className="font-medium">{c.code}</span> · {c.name}
                  </span>
                  <span className="flex items-center gap-2 text-muted">
                    {c.term}
                    {c.archived_at && <Badge>archived</Badge>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {isAdmin && (
          <Card
            title="GitHub organisations"
            description="Student repositories are created and monitored in these organisations."
            actions={
              session.githubLogin ? (
                <form action={connectGithubOrganisation}>
                  <input type="hidden" name="institutionId" value={institution.id} />
                  <input type="hidden" name="slug" value={slug} />
                  <Button type="submit" disabled={institution.status !== "active"}>
                    Connect organisation
                  </Button>
                </form>
              ) : (
                <form action={linkGithubAccount}>
                  <input type="hidden" name="slug" value={slug} />
                  <Button type="submit" variant="secondary">
                    Link your GitHub account
                  </Button>
                </form>
              )
            }
          >
            {activeInstallations.length === 0 ? (
              <EmptyState title="No organisation connected">
                {session.githubLogin
                  ? "Connect an organisation and install the HBE GitHub App on it."
                  : "Link your GitHub account, then connect an organisation."}
              </EmptyState>
            ) : (
              <ul className="divide-y divide-border">
                {activeInstallations.map((i) => (
                  <li key={i.installation_id} className="flex items-center justify-between py-2.5 text-sm">
                    <span className="font-medium">{i.account_login}</span>
                    {i.suspended_at ? <Badge tone="warning">suspended</Badge> : <Badge tone="success">connected</Badge>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </div>
    </AppShell>
  );
}
