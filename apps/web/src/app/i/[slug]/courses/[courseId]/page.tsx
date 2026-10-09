import { formatInZone, riskFlags } from "@hbe/core";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CourseMatrix, OVERVIEW_COLUMNS, type OverviewRow } from "@/components/course-matrix";
import { AutoRefresh } from "@/components/auto-refresh";
import { Alert, Badge, Button, ButtonLink, Card, EmptyState } from "@/components/ui";
import { requireMembership } from "@/lib/institution";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { loadMembers } from "../../members/data";
import { InviteForm } from "../../members/forms";
import { removeCourseMember, setCourseArchived } from "../actions";
import { AddCourseMemberForm } from "../forms";
import { ClassroomCard } from "./classroom-card";
import { syncLmsRoster } from "./lms-actions";
import { TeamsCard } from "./teams-card";

type Props = {
  params: Promise<{ slug: string; courseId: string }>;
  searchParams?: Promise<Record<string, string | undefined>>;
};

const ROLE_ORDER = ["instructor", "ta", "student"] as const;
const ROLE_TITLES: Record<string, string> = {
  instructor: "Instructors",
  ta: "Teaching assistants",
  student: "Students",
};

async function loadCourse(slug: string, courseId: string) {
  const ctx = await requireMembership(slug);
  if (!/^[0-9a-f-]{36}$/.test(courseId)) notFound();
  const supabase = await createSupabaseServerClient();
  const { data: course } = await supabase
    .from("courses")
    .select("id, code, name, term, timezone, archived_at, github:github_installations(account_login)")
    .eq("id", courseId)
    .eq("institution_id", ctx.institution.id)
    .maybeSingle();
  if (!course) notFound();
  return {
    ctx,
    supabase,
    course: course as unknown as {
      id: string;
      code: string;
      name: string;
      term: string;
      timezone: string;
      archived_at: string | null;
      github: { account_login: string } | null;
    },
  };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug, courseId } = await params;
  const { course } = await loadCourse(slug, courseId);
  return { title: `${course.code} · ${course.name}` };
}

export default async function CoursePage({ params, searchParams }: Props) {
  const { slug, courseId } = await params;
  const query = (await searchParams) ?? {};
  const { ctx, supabase, course } = await loadCourse(slug, courseId);

  const { data: assignmentRows } = await supabase
    .from("assignments")
    .select("id, title, status, due_at")
    .eq("course_id", course.id)
    .order("due_at");
  const { data: memberships } = await supabase
    .from("course_memberships")
    .select("id, user_id, role, profile:profiles(full_name, email, github_login)")
    .eq("course_id", course.id);
  const members = (memberships ?? []) as unknown as {
    id: string;
    user_id: string;
    role: string;
    profile: { full_name: string | null; email: string | null; github_login: string | null } | null;
  }[];
  const myRole = members.find((m) => m.user_id === ctx.session.userId)?.role;
  const canManage = ctx.writable && !course.archived_at && (ctx.isAdmin || myRole === "instructor");
  const isCourseStaff = ctx.isAdmin || myRole === "instructor" || myRole === "ta";

  // Staff dashboard: every student's state on every published assignment.
  const openAssignments = (assignmentRows ?? []).filter((a) => a.status !== "draft");
  const students = members
    .filter((m) => m.role === "student")
    .map((m) => ({ userId: m.user_id, name: m.profile?.full_name ?? m.profile?.email ?? "Unknown" }))
    .sort((x, y) => x.name.localeCompare(y.name));
  const [overview, extensions] =
    isCourseStaff && openAssignments.length
      ? await Promise.all([
          supabase.from("submission_overview").select(OVERVIEW_COLUMNS).eq("course_id", course.id),
          supabase
            .from("assignment_extensions")
            .select("assignment_id, user_id, due_at")
            .in(
              "assignment_id",
              openAssignments.map((a) => a.id),
            ),
        ])
      : [null, null];
  const rowByKey = new Map(
    ((overview?.data ?? []) as unknown as OverviewRow[]).map((r) => [`${r.user_id}/${r.assignment_id}`, r]),
  );
  const extensionByKey = new Map(
    ((extensions?.data ?? []) as { assignment_id: string; user_id: string; due_at: string }[]).map((x) => [
      `${x.user_id}/${x.assignment_id}`,
      x.due_at,
    ]),
  );
  const now = new Date();
  const cell = (userId: string, assignmentId: string) => {
    const key = `${userId}/${assignmentId}`;
    const row = rowByKey.get(key);
    const a = openAssignments.find((x) => x.id === assignmentId)!;
    const risks = row
      ? riskFlags({
          now,
          deadline: new Date(extensionByKey.get(key) ?? a.due_at),
          finalized: Boolean(row.finalized_at),
          hasRepository: Boolean(row.repository_id),
          lastActivityAt: row.last_activity_at ? new Date(row.last_activity_at) : null,
          startedAt: new Date(row.created_at),
          latestScore: row.latest_run_score === null ? null : Number(row.latest_run_score),
        })
      : [];
    return {
      row,
      risks,
      href: row ? `/i/${slug}/courses/${course.id}/assignments/${assignmentId}/submissions/${row.submission_id}` : null,
    };
  };
  const atRisk = students.flatMap((st) =>
    openAssignments
      .map((a) => ({ student: st, assignment: a, ...cell(st.userId, a.id) }))
      .filter((c) => c.risks.length > 0),
  );

  const { data: lmsLinks } = isCourseStaff
    ? await supabase
        .from("lms_course_links")
        .select(
          "id, context_title, context_id, nrps_url, roster_synced_at, roster_summary, connection:lms_connections(name, type)",
        )
        .eq("course_id", course.id)
    : { data: [] };
  const lmsLinkRows = (lmsLinks ?? []) as unknown as {
    id: string;
    context_title: string | null;
    context_id: string;
    nrps_url: string | null;
    roster_synced_at: string | null;
    roster_summary: { members: number; linked: number; waiting: number; added: number; inactive: number } | null;
    connection: { name: string; type: string } | null;
  }[];
  const hasRoster = (l: (typeof lmsLinkRows)[number]) =>
    Boolean(l.nrps_url) || l.connection?.type === "google_classroom";
  const lmsName = (l: (typeof lmsLinkRows)[number]) =>
    `${l.context_title ?? l.context_id} (${l.connection?.name ?? "LMS"})`;
  const lmsCourses = lmsLinkRows.map(lmsName);
  // After "Read the roster now": refresh until it has been read (for two minutes at most).
  const rosterAsked = Number(query.roster) || 0;
  const readingRoster =
    Date.now() - rosterAsked < 120_000 &&
    lmsLinkRows.some((l) => hasRoster(l) && (!l.roster_synced_at || Date.parse(l.roster_synced_at) < rosterAsked));

  const candidates = canManage
    ? (await loadMembers(supabase, ctx.institution.id))
        .filter((m) => m.status === "active" && !members.some((cm) => cm.user_id === m.user_id))
        .map((m) => ({
          userId: m.user_id,
          role: m.role,
          label: `${m.profile?.full_name ?? m.profile?.email ?? "Unknown"} (${m.role})`,
        }))
    : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">
            {course.code} · {course.name}
          </h2>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
            {course.term}
            {course.github && <span>· GitHub: {course.github.account_login}</span>}
            {lmsCourses.length > 0 && <span data-testid="lms-linked">· LMS: {lmsCourses.join(", ")}</span>}
            {course.archived_at && <Badge>archived</Badge>}
            {myRole && <Badge tone="accent">{myRole === "ta" ? "teaching assistant" : myRole}</Badge>}
          </p>
        </div>
        {(ctx.isAdmin || myRole === "instructor") && ctx.writable && (
          <form action={setCourseArchived}>
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="courseId" value={course.id} />
            <input type="hidden" name="archived" value={course.archived_at ? "false" : "true"} />
            <Button type="submit" variant="secondary">
              {course.archived_at ? "Restore course" : "Archive course"}
            </Button>
          </form>
        )}
      </div>

      <Card
        title="Assignments"
        actions={
          canManage && (
            <ButtonLink href={`/i/${slug}/courses/${course.id}/assignments/new`} variant="secondary">
              New assignment
            </ButtonLink>
          )
        }
      >
        {(assignmentRows ?? []).length === 0 ? (
          <EmptyState title="No assignments yet" />
        ) : (
          <ul className="divide-y divide-border">
            {(assignmentRows ?? []).map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                <Link
                  href={`/i/${slug}/courses/${course.id}/assignments/${a.id}`}
                  className="font-medium hover:text-accent"
                >
                  {a.title}
                </Link>
                <span className="flex items-center gap-2 text-muted">
                  due {formatInZone(a.due_at, course.timezone)}
                  {isCourseStaff && a.status !== "published" && (
                    <Badge tone={a.status === "draft" ? "warning" : "neutral"}>{a.status}</Badge>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {isCourseStaff && openAssignments.length > 0 && students.length > 0 && (
        <Card
          title="Progress"
          description={`${students.length} students · ${openAssignments.length} assignments`}
          actions={
            <a href={`/i/${slug}/courses/${course.id}/grades.csv`} className="text-sm text-accent hover:underline">
              Export grades (CSV)
            </a>
          }
        >
          <CourseMatrix
            students={students}
            assignments={openAssignments.map((a) => ({ id: a.id, title: a.title }))}
            cell={cell}
          />
        </Card>
      )}

      {isCourseStaff && atRisk.length > 0 && (
        <Card title="May need a nudge" description="Signals only; they never affect grades.">
          <ul className="divide-y divide-border">
            {atRisk.map((r) => (
              <li
                key={`${r.student.userId}/${r.assignment.id}`}
                className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
              >
                <span>
                  {r.href ? (
                    <Link href={r.href} className="font-medium hover:text-accent">
                      {r.student.name}
                    </Link>
                  ) : (
                    <span className="font-medium">{r.student.name}</span>
                  )}
                  <span className="text-muted"> · {r.assignment.title}</span>
                </span>
                <span className="text-warning">{r.risks.join("; ")}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <TeamsCard
        supabase={supabase}
        slug={slug}
        courseId={course.id}
        canManage={canManage}
        isStaff={isCourseStaff}
        userId={ctx.session.userId}
        students={students.map((st) => ({ userId: st.userId, name: st.name }))}
        query={query}
      />

      {isCourseStaff && (
        <ClassroomCard
          supabase={supabase}
          slug={slug}
          courseId={course.id}
          institutionId={ctx.institution.id}
          userId={ctx.session.userId}
          canManage={canManage}
          query={query}
        />
      )}

      {isCourseStaff && lmsLinkRows.length > 0 && (
        <section id="lms">
          <Card
            title="LMS roster"
            description="Read from the LMS every night: its students who are members here join this course."
          >
            <AutoRefresh active={readingRoster} intervalMs={4000} />
            {query.roster_error && <Alert tone="error">{query.roster_error}</Alert>}
            {readingRoster && <Alert tone="success">Reading the roster from the LMS…</Alert>}
            <ul className="divide-y divide-border text-sm" data-testid="lms-roster">
              {lmsLinkRows.map((l) => (
                <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <span>
                    {lmsName(l)}
                    <span className="block text-xs text-muted">
                      {!hasRoster(l)
                        ? "This LMS course doesn't share its roster with the platform."
                        : l.roster_synced_at && l.roster_summary
                          ? `Read ${formatInZone(l.roster_synced_at, course.timezone)}: ${l.roster_summary.members} people, ${l.roster_summary.added} added to this course, ${l.roster_summary.waiting} waiting for an admin to match them`
                          : "Not read yet."}
                    </span>
                  </span>
                  {canManage && hasRoster(l) && (
                    <form action={syncLmsRoster}>
                      <input type="hidden" name="slug" value={slug} />
                      <input type="hidden" name="courseId" value={course.id} />
                      <input type="hidden" name="linkId" value={l.id} />
                      <Button type="submit" variant="secondary">
                        Read the roster now
                      </Button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}

      {isCourseStaff && (
        <Card title="People" description={`${members.length} in this course`}>
          {members.length === 0 ? (
            <EmptyState title="Nobody in this course yet" />
          ) : (
            <div className="space-y-5">
              {ROLE_ORDER.map((role) => {
                const group = members.filter((m) => m.role === role);
                if (group.length === 0) return null;
                return (
                  <section key={role}>
                    <h3 className="mb-1 text-sm font-medium text-muted">
                      {ROLE_TITLES[role]} ({group.length})
                    </h3>
                    <ul className="divide-y divide-border">
                      {group.map((m) => (
                        <li key={m.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                          <span>
                            {role === "student" ? (
                              <Link href={`/i/${slug}/students/${m.user_id}`} className="hover:text-accent">
                                {m.profile?.full_name ?? m.profile?.email ?? "Unknown"}
                              </Link>
                            ) : (
                              (m.profile?.full_name ?? m.profile?.email ?? "Unknown")
                            )}
                            <span className="text-muted">
                              {m.profile?.github_login
                                ? ` · @${m.profile.github_login}`
                                : role === "student"
                                  ? " · GitHub not linked"
                                  : ""}
                            </span>
                          </span>
                          {canManage && m.user_id !== ctx.session.userId && (
                            <form action={removeCourseMember}>
                              <input type="hidden" name="slug" value={slug} />
                              <input type="hidden" name="courseId" value={course.id} />
                              <input type="hidden" name="id" value={m.id} />
                              <Button type="submit" variant="secondary" className="px-2.5 py-1">
                                Remove
                              </Button>
                            </form>
                          )}
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}
            </div>
          )}
        </Card>
      )}

      {canManage && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card title="Add an institution member">
            <AddCourseMemberForm slug={slug} courseId={course.id} candidates={candidates} />
          </Card>
          {ctx.isAdmin && (
            <Card title="Invite to this course" description="For people who are not members yet.">
              <InviteForm slug={slug} courses={[]} fixedCourseId={course.id} />
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
