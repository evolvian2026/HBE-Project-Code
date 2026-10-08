import { formatInZone } from "@hbe/core";
import type { Metadata } from "next";
import Link from "next/link";
import { linkGithubAccount } from "@/app/i/[slug]/actions";
import { MarkdownView } from "@/components/markdown";
import { Alert, Badge, Button, ButtonLink, Card, EmptyState } from "@/components/ui";
import { deleteAssignment, removeCriterion } from "../actions";
import { loadAssignment } from "../data";
import { CriterionForm, PublishForm } from "./forms";

type Props = {
  params: Promise<{ slug: string; courseId: string; assignmentId: string }>;
  searchParams?: Promise<Record<string, string | undefined>>;
};

const STATUS_TONE = { draft: "warning", published: "success", closed: "neutral" } as const;
const SUBMISSION_LABEL: Record<
  string,
  { label: string; tone: "neutral" | "accent" | "success" | "warning" | "danger" }
> = {
  waiting_for_github: { label: "waiting for GitHub link", tone: "warning" },
  provisioning: { label: "creating repository", tone: "accent" },
  active: { label: "repository ready", tone: "success" },
  provisioning_failed: { label: "repository failed", tone: "danger" },
  submitted: { label: "submitted", tone: "success" },
  graded: { label: "graded", tone: "success" },
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug, courseId, assignmentId } = await params;
  const { assignment } = await loadAssignment(slug, courseId, assignmentId);
  return { title: assignment.title };
}

export default async function AssignmentPage({ params, searchParams }: Props) {
  const { slug, courseId, assignmentId } = await params;
  const query = (await searchParams) ?? {};
  const published = query.published !== undefined ? Number(query.published) : null;
  const {
    ctx,
    course,
    canManage,
    isCourseStaff,
    supabase,
    assignment: a,
  } = await loadAssignment(slug, courseId, assignmentId);
  const ids = { slug, courseId: course.id, assignmentId: a.id };
  const base = `/i/${slug}/courses/${course.id}`;

  const [criteria, submissions, extension] = await Promise.all([
    supabase
      .from("assignment_criteria")
      .select("id, title, description, max_points")
      .eq("assignment_id", a.id)
      .order("position"),
    supabase
      .from("submissions")
      .select(
        "id, user_id, status, status_detail, profile:profiles(full_name, email, github_login), repository:repositories(owner, name)",
      )
      .eq("assignment_id", a.id),
    supabase
      .from("assignment_extensions")
      .select("due_at")
      .eq("assignment_id", a.id)
      .eq("user_id", ctx.session.userId)
      .maybeSingle(),
  ]);
  type Submission = {
    id: string;
    user_id: string;
    status: string;
    status_detail: string | null;
    profile: { full_name: string | null; email: string | null; github_login: string | null } | null;
    repository: { owner: string; name: string } | null;
  };
  const subs = ((submissions.data ?? []) as unknown as Submission[]).sort((x, y) =>
    (x.profile?.full_name ?? x.profile?.email ?? "").localeCompare(y.profile?.full_name ?? y.profile?.email ?? ""),
  );
  const mine = subs.find((s) => s.user_id === ctx.session.userId);
  const totalPoints = (criteria.data ?? []).reduce((sum, c) => sum + Number(c.max_points), 0);
  const effectiveDue = extension.data?.due_at ?? a.due_at;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm text-muted">
            <Link href={base} className="hover:text-text">
              {course.code} · {course.name}
            </Link>
          </p>
          <h2 className="mt-1 flex flex-wrap items-center gap-2 text-xl font-semibold">
            {a.title}
            {isCourseStaff && <Badge tone={STATUS_TONE[a.status]}>{a.status}</Badge>}
          </h2>
          <p className="mt-1 text-sm text-muted">
            Due {formatInZone(effectiveDue, course.timezone)}
            {extension.data && " (your extension)"}
            {a.profile && ` · ${a.profile.display_name}`}
          </p>
        </div>
        {canManage && (
          <div className="flex gap-2">
            {a.status !== "closed" && (
              <ButtonLink href={`${base}/assignments/${a.id}/edit`} variant="secondary">
                Edit
              </ButtonLink>
            )}
            {a.status === "draft" && (
              <form action={deleteAssignment}>
                <input type="hidden" name="slug" value={slug} />
                <input type="hidden" name="courseId" value={course.id} />
                <input type="hidden" name="assignmentId" value={a.id} />
                <Button type="submit" variant="secondary">
                  Delete draft
                </Button>
              </form>
            )}
          </div>
        )}
      </div>

      {published !== null && Number.isFinite(published) && (
        <Alert tone="success">
          Published. {published} student{published === 1 ? "" : "s"} will get a repository.
        </Alert>
      )}

      {canManage && a.status === "draft" && (
        <Card title="Publish" description="Students get their own repository from the template and can start working.">
          <PublishForm {...ids} />
        </Card>
      )}

      {mine && (
        <Card title="Your repository">
          {mine.status === "waiting_for_github" ? (
            <div className="space-y-3">
              <Alert tone="info">
                Link your GitHub account so we can create your repository and credit your commits to you.
              </Alert>
              <form action={linkGithubAccount}>
                <input type="hidden" name="slug" value={slug} />
                <input type="hidden" name="next" value={`${base}/assignments/${a.id}`} />
                <Button type="submit">Link your GitHub account</Button>
              </form>
            </div>
          ) : mine.repository && mine.status !== "provisioning" ? (
            <p className="text-sm">
              <a
                href={`https://github.com/${mine.repository.owner}/${mine.repository.name}`}
                className="font-medium text-accent hover:underline"
              >
                github.com/{mine.repository.owner}/{mine.repository.name}
              </a>
            </p>
          ) : (
            <p className="text-sm text-muted">
              {SUBMISSION_LABEL[mine.status]?.label ?? mine.status}
              {mine.status_detail ? `: ${mine.status_detail}` : "…"}
            </p>
          )}
        </Card>
      )}

      <Card title="Specification">
        {a.spec_md.trim() ? <MarkdownView>{a.spec_md}</MarkdownView> : <EmptyState title="No specification yet" />}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="How it is graded">
          <dl className="grid grid-cols-2 gap-y-2 text-sm">
            <dt className="text-muted">Automated tests</dt>
            <dd className="text-right tabular-nums">{a.weights.automated}%</dd>
            <dt className="text-muted">Rubric (staff review)</dt>
            <dd className="text-right tabular-nums">{a.weights.rubric}%</dd>
            <dt className="text-muted">Process (activity)</dt>
            <dd className="text-right tabular-nums">{a.weights.process}%</dd>
            <dt className="text-muted">Late penalty</dt>
            <dd className="text-right">
              {a.late_policy.per_day_percent}% per day, up to {a.late_policy.max_days} days
            </dd>
            <dt className="text-muted">Grace period</dt>
            <dd className="text-right">{a.late_policy.grace_minutes} min</dd>
            <dt className="text-muted">Test runs</dt>
            <dd className="text-right">{a.run_quota_per_day} per day</dd>
          </dl>
        </Card>

        <Card title="Rubric" description={totalPoints ? `${totalPoints} points` : undefined}>
          {(criteria.data ?? []).length === 0 ? (
            <EmptyState title="No rubric criteria" />
          ) : (
            <ul className="divide-y divide-border">
              {(criteria.data ?? []).map((c) => (
                <li key={c.id} className="flex items-start justify-between gap-3 py-2.5 text-sm">
                  <div>
                    <p className="font-medium">{c.title}</p>
                    {c.description && <p className="text-muted">{c.description}</p>}
                  </div>
                  <span className="flex items-center gap-2 tabular-nums">
                    {Number(c.max_points)} pts
                    {canManage && (
                      <form action={removeCriterion}>
                        <input type="hidden" name="slug" value={slug} />
                        <input type="hidden" name="courseId" value={course.id} />
                        <input type="hidden" name="assignmentId" value={a.id} />
                        <input type="hidden" name="id" value={c.id} />
                        <Button type="submit" variant="secondary" className="px-2 py-0.5 text-xs">
                          Remove
                        </Button>
                      </form>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {canManage && (
            <div className="mt-4 border-t border-border pt-4">
              <CriterionForm {...ids} />
            </div>
          )}
        </Card>
      </div>

      {isCourseStaff && a.status !== "draft" && (
        <Card title="Submissions" description={`${subs.length} students`}>
          {subs.length === 0 ? (
            <EmptyState title="No students in this course" />
          ) : (
            <ul className="divide-y divide-border">
              {subs.map((s) => {
                const label = SUBMISSION_LABEL[s.status] ?? { label: s.status, tone: "neutral" as const };
                return (
                  <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                    <span>
                      {s.profile?.full_name ?? s.profile?.email ?? "Unknown"}
                      <span className="text-muted">
                        {s.profile?.github_login ? ` · @${s.profile.github_login}` : ""}
                      </span>
                    </span>
                    <span className="flex items-center gap-3">
                      {s.repository && (
                        <a
                          href={`https://github.com/${s.repository.owner}/${s.repository.name}`}
                          className="text-accent hover:underline"
                        >
                          {s.repository.name}
                        </a>
                      )}
                      <Badge tone={label.tone}>{label.label}</Badge>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}
