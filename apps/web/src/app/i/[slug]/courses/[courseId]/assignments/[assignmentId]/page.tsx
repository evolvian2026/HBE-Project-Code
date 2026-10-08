import { formatInZone, submissionCutoff, utcToZonedLocal, type ProcessResult } from "@hbe/core";
import type { Metadata } from "next";
import Link from "next/link";
import { linkGithubAccount } from "@/app/i/[slug]/actions";
import { AutoRefresh } from "@/components/auto-refresh";
import { isActive, RunList, runOutcome, type RunSummary } from "@/components/evaluation";
import { fmt, GRADE_COLUMNS, GradeBreakdown, type GradeRow } from "@/components/grade";
import { MarkdownView } from "@/components/markdown";
import { ProcessBreakdown } from "@/components/process-breakdown";
import { Alert, Badge, Button, ButtonLink, Card, EmptyState } from "@/components/ui";
import { deleteAssignment, removeCriterion, retryProvisioning } from "../actions";
import { loadAssignment } from "../data";
import { CriterionForm, PublishForm, ReleaseGradesForm, RunTestsForm } from "./forms";
import { RegradeRequestForm } from "./regrade-forms";
import { REGRADE_COLUMNS, RegradeHistory, type RegradeRequest } from "./regrades";

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
  missing: { label: "nothing submitted", tone: "danger" },
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

  const [criteria, submissions, extension, snapshots, runs, grades, openRegrades] = await Promise.all([
    supabase
      .from("assignment_criteria")
      .select("id, title, description, max_points")
      .eq("assignment_id", a.id)
      .order("position"),
    supabase
      .from("submissions")
      .select(
        "id, user_id, status, status_detail, final_sha, submitted_at, late_days, finalized_at, grade_released_at, profile:profiles(full_name, email, github_login), repository:repositories(owner, name)",
      )
      .eq("assignment_id", a.id),
    supabase
      .from("assignment_extensions")
      .select("due_at")
      .eq("assignment_id", a.id)
      .eq("user_id", ctx.session.userId)
      .maybeSingle(),
    supabase
      .from("process_snapshots")
      .select("submission_id, score, breakdown, submission:submissions!inner(assignment_id)")
      .eq("submission.assignment_id", a.id),
    a.suite
      ? supabase
          .from("evaluation_runs")
          .select(
            "id, submission_id, sha, trigger, status, score, summary, queued_at, requested_by, submission:submissions!inner(assignment_id)",
          )
          .eq("submission.assignment_id", a.id)
          .order("queued_at", { ascending: false })
          .limit(1000)
      : Promise.resolve({ data: [] as never[] }),
    // Staff see every current grade; students only their own, once released (RLS).
    supabase
      .from("grades")
      .select(`${GRADE_COLUMNS}, submission_id, submission:submissions!inner(assignment_id)`)
      .eq("is_current", true)
      .eq("submission.assignment_id", a.id),
    isCourseStaff
      ? supabase
          .from("regrade_requests")
          .select("submission_id, submission:submissions!inner(assignment_id)")
          .eq("status", "open")
          .eq("submission.assignment_id", a.id)
      : Promise.resolve({ data: [] as never[] }),
  ]);
  const regradeOpen = new Set(((openRegrades.data ?? []) as { submission_id: string }[]).map((r) => r.submission_id));
  const gradeBySubmission = new Map(
    ((grades.data ?? []) as unknown as (GradeRow & { submission_id: string })[]).map((g) => [g.submission_id, g]),
  );
  type Run = RunSummary & { submission_id: string; requested_by: string | null };
  const allRuns = (runs.data ?? []) as unknown as Run[];
  /** Latest scored run per submission (runs are newest first). */
  const latestScored = new Map<string, Run>();
  for (const r of allRuns)
    if (r.status === "completed" && !latestScored.has(r.submission_id)) latestScored.set(r.submission_id, r);
  const processBySubmission = new Map(
    ((snapshots.data ?? []) as unknown as { submission_id: string; score: string; breakdown: ProcessResult }[]).map(
      (p) => [p.submission_id, p],
    ),
  );
  type Submission = {
    id: string;
    user_id: string;
    status: string;
    status_detail: string | null;
    final_sha: string | null;
    submitted_at: string | null;
    late_days: number | null;
    finalized_at: string | null;
    grade_released_at: string | null;
    profile: { full_name: string | null; email: string | null; github_login: string | null } | null;
    repository: { owner: string; name: string } | null;
  };
  const subs = ((submissions.data ?? []) as unknown as Submission[]).sort((x, y) =>
    (x.profile?.full_name ?? x.profile?.email ?? "").localeCompare(y.profile?.full_name ?? y.profile?.email ?? ""),
  );
  const mine = subs.find((s) => s.user_id === ctx.session.userId);
  const totalPoints = (criteria.data ?? []).reduce((sum, c) => sum + Number(c.max_points), 0);
  const effectiveDue = extension.data?.due_at ?? a.due_at;
  const myRuns = mine ? allRuns.filter((r) => r.submission_id === mine.id) : [];
  const today = utcToZonedLocal(new Date(), course.timezone).slice(0, 10);
  const manualToday = myRuns.filter(
    (r) => r.trigger === "manual" && utcToZonedLocal(new Date(r.queued_at), course.timezone).slice(0, 10) === today,
  ).length;
  const runsLeft = Math.max(0, a.run_quota_per_day - manualToday);
  const pastDeadline = Date.now() > new Date(effectiveDue).getTime() + a.late_policy.grace_minutes * 60_000;
  const cutoff = submissionCutoff(new Date(effectiveDue), a.late_policy);
  const gradedRun = mine ? myRuns.find((r) => r.trigger === "deadline" || r.trigger === "regrade") : undefined;
  const myGrade = mine ? gradeBySubmission.get(mine.id) : undefined;
  const [myScores, myFeedback, myReports, myRegrades] = myGrade
    ? await Promise.all([
        supabase.from("rubric_scores").select("criterion_id, points, comment").eq("submission_id", mine!.id),
        supabase.from("feedback").select("body_md").eq("submission_id", mine!.id).maybeSingle(),
        supabase
          .from("grade_reports")
          .select("id, version, generated_at")
          .eq("submission_id", mine!.id)
          .order("version", { ascending: false }),
        supabase
          .from("regrade_requests")
          .select(REGRADE_COLUMNS)
          .eq("submission_id", mine!.id)
          .order("created_at", { ascending: false }),
      ])
    : [null, null, null, null];
  const regrades = (myRegrades?.data ?? []) as RegradeRequest[];
  const regradeCloses =
    mine?.grade_released_at && a.regrade_window_days > 0
      ? new Date(new Date(mine.grade_released_at).getTime() + a.regrade_window_days * 86_400_000)
      : null;
  const canAskRegrade =
    regradeCloses !== null && Date.now() < regradeCloses.getTime() && !regrades.some((r) => r.status === "open");
  const latestReport = (myReports?.data ?? [])[0] as { id: string; version: number; generated_at: string } | undefined;
  const myScoreByCriterion = new Map(
    ((myScores?.data ?? []) as { criterion_id: string; points: string; comment: string | null }[]).map((r) => [
      r.criterion_id,
      r,
    ]),
  );
  const finalizedCount = subs.filter((s) => s.finalized_at).length;
  const gradeStats = [...gradeBySubmission.values()].reduce(
    (acc, g) => ({
      complete: acc.complete + (g.complete ? 1 : 0),
      released: acc.released + (g.released_at ? 1 : 0),
    }),
    { complete: 0, released: 0 },
  );
  const lateLabel = (days: number) =>
    `${days} day${days === 1 ? "" : "s"} late · −${Math.min(100, days * a.late_policy.per_day_percent)}%`;

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

      {myGrade && (
        <Card
          title="Your grade"
          description={`Released ${formatInZone(myGrade.released_at!, course.timezone)}`}
          actions={
            latestReport ? (
              <span className="flex gap-3 text-sm">
                <a href={`/i/${slug}/reports/${latestReport.id}/pdf`} className="text-accent hover:underline">
                  Grade report (PDF)
                </a>
                <a href={`/i/${slug}/reports/${latestReport.id}/json`} className="text-accent hover:underline">
                  JSON
                </a>
              </span>
            ) : (
              <span className="text-sm text-muted">Report being prepared…</span>
            )
          }
        >
          <div className="grid gap-8 lg:grid-cols-2">
            <GradeBreakdown grade={myGrade} />
            <div className="space-y-4">
              {(criteria.data ?? []).length > 0 && (
                <ul className="divide-y divide-border text-sm">
                  {(criteria.data ?? []).map((c) => {
                    const score = myScoreByCriterion.get(c.id);
                    return (
                      <li key={c.id} className="py-2">
                        <p className="flex justify-between gap-3">
                          <span className="font-medium">{c.title}</span>
                          <span className="tabular-nums">
                            {score ? fmt(score.points) : "–"} / {fmt(c.max_points)}
                          </span>
                        </p>
                        {score?.comment && <p className="mt-1 text-muted">{score.comment}</p>}
                      </li>
                    );
                  })}
                </ul>
              )}
              {myFeedback?.data?.body_md.trim() && (
                <div>
                  <h3 className="mb-1 text-sm font-medium">Feedback</h3>
                  <MarkdownView>{myFeedback.data.body_md}</MarkdownView>
                </div>
              )}
            </div>
          </div>
        </Card>
      )}

      {myGrade && (regrades.length > 0 || regradeCloses) && (
        <Card
          title="Regrade"
          description={
            regradeCloses
              ? Date.now() < regradeCloses.getTime()
                ? `You can ask for a regrade until ${formatInZone(regradeCloses, course.timezone)}.`
                : `Regrade requests closed ${formatInZone(regradeCloses, course.timezone)}.`
              : undefined
          }
        >
          {regrades.length > 0 && <RegradeHistory requests={regrades} timezone={course.timezone} withdraw={ids} />}
          {canAskRegrade && (
            <div className={regrades.length > 0 ? "mt-4 border-t border-border pt-4" : ""}>
              <RegradeRequestForm ids={{ ...ids, submissionId: mine!.id }} />
            </div>
          )}
        </Card>
      )}

      {mine?.finalized_at && (
        <Card title="Your submission">
          {mine.final_sha ? (
            <div className="space-y-2 text-sm">
              <p className="flex flex-wrap items-center gap-2">
                Graded commit{" "}
                {mine.repository ? (
                  <a
                    href={`https://github.com/${mine.repository.owner}/${mine.repository.name}/commit/${mine.final_sha}`}
                    className="font-mono text-accent hover:underline"
                  >
                    {mine.final_sha.slice(0, 7)}
                  </a>
                ) : (
                  <span className="font-mono">{mine.final_sha.slice(0, 7)}</span>
                )}
                , pushed {mine.submitted_at && formatInZone(mine.submitted_at, course.timezone)}
                {mine.late_days ? (
                  <Badge tone="warning">{lateLabel(mine.late_days)}</Badge>
                ) : (
                  <Badge tone="success">on time</Badge>
                )}
              </p>
              {gradedRun && (
                <p>
                  <Link
                    href={`${base}/assignments/${a.id}/submissions/${mine.id}/runs/${gradedRun.id}`}
                    className="text-accent hover:underline"
                  >
                    Graded test run
                  </Link>
                  {runOutcome(gradedRun) && <span className="text-muted"> · {runOutcome(gradedRun)}</span>}
                </p>
              )}
            </div>
          ) : (
            <Alert tone="error">
              Nothing was pushed to your repository&apos;s default branch before the cutoff (
              {formatInZone(cutoff, course.timezone)}). Talk to your instructor if you need an extension.
            </Alert>
          )}
        </Card>
      )}

      {mine && !mine.finalized_at && pastDeadline && a.status === "published" && (
        <Alert tone="info">
          The deadline has passed. Pushes until {formatInZone(cutoff, course.timezone)} are accepted as late work, at −
          {a.late_policy.per_day_percent}% for each started day; your latest push before then is graded.
        </Alert>
      )}

      {mine && mine.repository && ["active", "submitted", "graded"].includes(mine.status) && (
        <Card
          title="Your progress"
          description={
            mine.finalized_at
              ? "Final: activity up to your deadline."
              : "Updated as you push. Counts toward your grade."
          }
        >
          {processBySubmission.get(mine.id) ? (
            <ProcessBreakdown result={processBySubmission.get(mine.id)!.breakdown} weightInGrade={a.weights.process} />
          ) : (
            <EmptyState title="No activity yet">Push your first commit to start.</EmptyState>
          )}
          <p className="mt-4 text-sm">
            <Link href={`${base}/assignments/${a.id}/submissions/${mine.id}`} className="text-accent hover:underline">
              See your commit history
            </Link>
          </p>
        </Card>
      )}

      {mine && mine.status === "active" && a.suite && a.status === "published" && (
        <Card title="Automated tests" description={`${a.weights.automated}% of your grade`}>
          <AutoRefresh active={myRuns.some((r) => isActive(r.status))} />
          {myRuns.length === 0 ? (
            <EmptyState title="No test runs yet">
              {a.triggers.on_push
                ? "Push to your default branch and the tests run automatically."
                : "Start a run once you have pushed your work."}
            </EmptyState>
          ) : (
            <RunList
              runs={myRuns.slice(0, 5)}
              timezone={course.timezone}
              href={(id) => `${base}/assignments/${a.id}/submissions/${mine.id}/runs/${id}`}
            />
          )}
          {a.triggers.manual && (
            <div className="mt-4 flex flex-wrap items-start justify-between gap-3 border-t border-border pt-4">
              <p className="text-sm text-muted">
                {runsLeft} of {a.run_quota_per_day} test runs left today. Tests your latest push.
              </p>
              <RunTestsForm {...ids} submissionId={mine.id} disabled={runsLeft === 0} />
            </div>
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
            <dt className="text-muted">Hidden tests</dt>
            <dd className="text-right">{a.suite ? a.suite.title : "none"}</dd>
            <dt className="text-muted">Test runs</dt>
            <dd className="text-right">{a.run_quota_per_day} per day</dd>
            <dt className="text-muted">Regrade requests</dt>
            <dd className="text-right">
              {a.regrade_window_days > 0 ? `${a.regrade_window_days} days after release` : "not offered"}
            </dd>
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

      {canManage && finalizedCount > 0 && (
        <Card
          title="Grades"
          description={`${finalizedCount} of ${subs.length} submissions are past their cutoff · ${gradeStats.complete} graded · ${gradeStats.released} released`}
        >
          <ReleaseGradesForm {...ids} disabled={gradeStats.complete === gradeStats.released} />
        </Card>
      )}

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
                      <Link href={`${base}/assignments/${a.id}/submissions/${s.id}`} className="hover:text-accent">
                        {s.profile?.full_name ?? s.profile?.email ?? "Unknown"}
                      </Link>
                      <span className="text-muted">
                        {s.profile?.github_login ? ` · @${s.profile.github_login}` : ""}
                      </span>
                    </span>
                    <span className="flex flex-wrap items-center justify-end gap-3">
                      {regradeOpen.has(s.id) && <Badge tone="warning">regrade requested</Badge>}
                      {s.status === "submitted" && s.late_days ? (
                        <span className="text-xs text-warning">{lateLabel(s.late_days)}</span>
                      ) : null}
                      {s.status === "provisioning_failed" && s.status_detail && (
                        <span className="max-w-md text-xs text-danger">{s.status_detail}</span>
                      )}
                      {s.status === "provisioning_failed" && canManage && (
                        <form action={retryProvisioning}>
                          <input type="hidden" name="slug" value={slug} />
                          <input type="hidden" name="courseId" value={course.id} />
                          <input type="hidden" name="assignmentId" value={a.id} />
                          <input type="hidden" name="submissionId" value={s.id} />
                          <Button type="submit" variant="secondary" className="px-2 py-0.5 text-xs">
                            Retry
                          </Button>
                        </form>
                      )}
                      {gradeBySubmission.get(s.id) && (
                        <span className="tabular-nums" title="Current grade">
                          grade {fmt(gradeBySubmission.get(s.id)!.final_score)}
                          {!gradeBySubmission.get(s.id)!.complete && " (incomplete)"}
                          {gradeBySubmission.get(s.id)!.released_at && " · released"}
                        </span>
                      )}
                      {latestScored.get(s.id) && (
                        <span className="tabular-nums text-muted" title="Latest test run">
                          tests {runOutcome(latestScored.get(s.id)!)}
                        </span>
                      )}
                      {processBySubmission.get(s.id) && (
                        <span className="tabular-nums text-muted" title="Process score">
                          process {Math.round(Number(processBySubmission.get(s.id)!.score))}
                        </span>
                      )}
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
