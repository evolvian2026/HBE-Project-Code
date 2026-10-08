import { formatInZone } from "@hbe/core";
import type { Metadata } from "next";
import Link from "next/link";
import { OVERVIEW_COLUMNS, type OverviewRow } from "@/components/course-matrix";
import { fmt } from "@/components/grade";
import { Alert, Badge, Button, Card, EmptyState } from "@/components/ui";
import { requireMembership } from "@/lib/institution";
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
  const ctx = await requireMembership(slug);
  return { title: ctx.institution.name };
}

export default async function InstitutionOverview({ params, searchParams }: Props) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const { session, institution, role, isAdmin, isStaff } = await requireMembership(slug);
  const supabase = await createSupabaseServerClient();

  const [courses, installations, members] = await Promise.all([
    supabase
      .from("courses")
      .select("id, code, name, term")
      .eq("institution_id", institution.id)
      .is("archived_at", null)
      .order("code"),
    isAdmin
      ? supabase
          .from("github_installations")
          .select("installation_id, account_login, suspended_at, deleted_at")
          .eq("institution_id", institution.id)
      : Promise.resolve({ data: [] as never[] }),
    isStaff
      ? supabase
          .from("institution_memberships")
          .select("role")
          .eq("institution_id", institution.id)
          .eq("status", "active")
      : Promise.resolve({ data: [] as never[] }),
  ]);

  // My assignments (students): what's due, how the tests look, and released grades.
  const mine = ((
    await supabase
      .from("submission_overview")
      .select(`${OVERVIEW_COLUMNS}, course_id`)
      .eq("user_id", session.userId)
      .eq("institution_id", institution.id)
  ).data ?? []) as unknown as (OverviewRow & { course_id: string })[];
  const [myAssignments, myExtensions] = mine.length
    ? await Promise.all([
        supabase
          .from("assignments")
          .select("id, title, due_at, course:courses(code, timezone)")
          .in(
            "id",
            mine.map((m) => m.assignment_id),
          ),
        supabase.from("assignment_extensions").select("assignment_id, due_at").eq("user_id", session.userId),
      ])
    : [null, null];
  const assignmentById = new Map(
    (
      (myAssignments?.data ?? []) as unknown as {
        id: string;
        title: string;
        due_at: string;
        course: { code: string; timezone: string } | null;
      }[]
    ).map((a) => [a.id, a]),
  );
  const extensionDue = new Map(
    ((myExtensions?.data ?? []) as { assignment_id: string; due_at: string }[]).map((x) => [x.assignment_id, x.due_at]),
  );
  const myWork = mine
    .filter((m) => assignmentById.has(m.assignment_id))
    .map((m) => {
      const a = assignmentById.get(m.assignment_id)!;
      return { ...m, a, due: extensionDue.get(m.assignment_id) ?? a.due_at };
    })
    // Open work first, soonest deadline first; then finished work, most recent first.
    .sort((x, y) =>
      Boolean(x.finalized_at) !== Boolean(y.finalized_at)
        ? x.finalized_at
          ? 1
          : -1
        : x.finalized_at
          ? y.due.localeCompare(x.due)
          : x.due.localeCompare(y.due),
    );

  const counts: Record<string, number> = { admin: 0, teacher: 0, student: 0 };
  for (const m of members.data ?? []) counts[m.role] = (counts[m.role] ?? 0) + 1;
  const activeInstallations = (installations.data ?? []).filter((i) => !i.deleted_at);

  return (
    <div className="space-y-6">
      {query.error && <Alert tone="error">{ERRORS[query.error] ?? query.error}</Alert>}

      {isStaff && (
        <div className="grid gap-4 sm:grid-cols-3">
          {(["admin", "teacher", "student"] as const).map((r) => (
            <Card key={r}>
              <p className="text-sm text-muted capitalize">{r}s</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{counts[r] ?? 0}</p>
            </Card>
          ))}
        </div>
      )}

      {myWork.length > 0 && (
        <Card title="My assignments">
          <ul className="divide-y divide-border">
            {myWork.map((w) => {
              const tests =
                w.latest_run_summary?.total !== undefined
                  ? `${w.latest_run_summary.passed}/${w.latest_run_summary.total} tests passing`
                  : null;
              return (
                <li key={w.submission_id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                  <span>
                    <Link
                      href={`/i/${slug}/courses/${w.course_id}/assignments/${w.assignment_id}`}
                      className="font-medium hover:text-accent"
                    >
                      {w.a.title}
                    </Link>
                    <span className="text-muted">
                      {" · "}
                      {w.a.course?.code} · due {formatInZone(w.due, w.a.course?.timezone ?? "UTC")}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    {w.final_score !== null ? (
                      <Badge tone="success">grade {fmt(w.final_score)}</Badge>
                    ) : w.status === "missing" ? (
                      <Badge tone="danger">nothing submitted</Badge>
                    ) : w.finalized_at ? (
                      <Badge tone="accent">{w.late_days ? `submitted ${w.late_days}d late` : "submitted"}</Badge>
                    ) : (
                      <>
                        {tests && <span className="text-muted">{tests}</span>}
                        <Badge tone={new Date(w.due) < new Date() ? "warning" : "neutral"}>
                          {new Date(w.due) < new Date() ? "late window" : "open"}
                        </Badge>
                      </>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <Card
        title={role === "student" ? "My courses" : "Active courses"}
        actions={
          <Link href={`/i/${slug}/courses`} className="text-sm text-accent hover:underline">
            All courses
          </Link>
        }
      >
        {(courses.data ?? []).length === 0 ? (
          <EmptyState title="No courses yet" />
        ) : (
          <ul className="divide-y divide-border">
            {(courses.data ?? []).map((c) => (
              <li key={c.id} className="flex items-center justify-between py-2.5 text-sm">
                <Link href={`/i/${slug}/courses/${c.id}`} className="hover:text-accent">
                  <span className="font-medium">{c.code}</span> · {c.name}
                </Link>
                <span className="text-muted">{c.term}</span>
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
  );
}
