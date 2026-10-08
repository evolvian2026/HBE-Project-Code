import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Badge, Button, Card, EmptyState } from "@/components/ui";
import { requireMembership } from "@/lib/institution";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { loadMembers } from "../../members/data";
import { InviteForm } from "../../members/forms";
import { removeCourseMember, setCourseArchived } from "../actions";
import { AddCourseMemberForm } from "../forms";

type Props = { params: Promise<{ slug: string; courseId: string }> };

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
    .select("id, code, name, term, archived_at, github:github_installations(account_login)")
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

export default async function CoursePage({ params }: Props) {
  const { slug, courseId } = await params;
  const { ctx, supabase, course } = await loadCourse(slug, courseId);

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
        description="Projects, automated tests and grading arrive with the next part of Phase 1."
      >
        <EmptyState title="No assignments yet" />
      </Card>

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
                            {m.profile?.full_name ?? m.profile?.email ?? "Unknown"}
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
