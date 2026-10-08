import {
  classifyCommit,
  formatInZone,
  submissionCutoff,
  utcToZonedLocal,
  type ProcessPolicy,
  type ProcessResult,
} from "@hbe/core";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AutoRefresh } from "@/components/auto-refresh";
import { isActive, RunList, type RunSummary } from "@/components/evaluation";
import { fmt, GRADE_COLUMNS, GradeBreakdown, type GradeRow } from "@/components/grade";
import { ProcessBreakdown } from "@/components/process-breakdown";
import { Badge, Card, EmptyState } from "@/components/ui";
import { loadAssignment } from "../../../data";
import { RunTestsForm } from "../../forms";
import { ExtensionForm } from "./extension-form";
import { OverrideForm, ReviewForm } from "./grading-forms";

type Props = { params: Promise<{ slug: string; courseId: string; assignmentId: string; submissionId: string }> };

export const metadata: Metadata = { title: "Submission" };

const REASON: Record<string, string> = {
  pending: "analysing",
  not_student: "not linked to the student",
  bot: "bot",
  merge: "merge commit",
  after_deadline: "after the deadline",
  too_small: "too small",
  unavailable: "no longer on GitHub",
};

export default async function SubmissionPage({ params }: Props) {
  const { slug, courseId, assignmentId, submissionId } = await params;
  const {
    course,
    supabase,
    isCourseStaff,
    canManage,
    assignment: a,
  } = await loadAssignment(slug, courseId, assignmentId);
  if (!/^[0-9a-f-]{36}$/.test(submissionId)) notFound();

  const { data: submission } = await supabase
    .from("submissions")
    .select(
      "id, user_id, status, repository_id, final_sha, submitted_at, late_days, finalized_at, profile:profiles(full_name, email, github_login), repository:repositories(owner, name)",
    )
    .eq("id", submissionId)
    .eq("assignment_id", a.id)
    .maybeSingle();
  if (!submission) notFound(); // RLS: only the student and course staff see it
  const s = submission as unknown as {
    id: string;
    user_id: string;
    status: string;
    repository_id: string | null;
    final_sha: string | null;
    submitted_at: string | null;
    late_days: number | null;
    finalized_at: string | null;
    profile: { full_name: string | null; email: string | null; github_login: string | null } | null;
    repository: { owner: string; name: string } | null;
  };

  const [snapshot, commits, prs, issues, extension, policyRow, runs, archive, reviewComments] = await Promise.all([
    supabase
      .from("process_snapshots")
      .select("breakdown, computed_at, is_final")
      .eq("submission_id", s.id)
      .maybeSingle(),
    s.repository_id
      ? supabase
          .from("commits")
          .select(
            "sha, message, authored_at, author_login, author_profile_id, is_bot, parent_count, effective_lines, details_status",
          )
          .eq("repository_id", s.repository_id)
          .order("authored_at", { ascending: false })
          .limit(200)
      : Promise.resolve({ data: [] as never[] }),
    s.repository_id
      ? supabase
          .from("pull_requests")
          .select("number, title, state, linked_issues, review_count, body_length")
          .eq("repository_id", s.repository_id)
          .order("number", { ascending: false })
      : Promise.resolve({ data: [] as never[] }),
    s.repository_id
      ? supabase
          .from("issues")
          .select("number, title, state")
          .eq("repository_id", s.repository_id)
          .order("number", { ascending: false })
      : Promise.resolve({ data: [] as never[] }),
    supabase
      .from("assignment_extensions")
      .select("due_at, reason")
      .eq("assignment_id", a.id)
      .eq("user_id", s.user_id)
      .maybeSingle(),
    supabase.from("assignments").select("process_policy").eq("id", a.id).single(),
    supabase
      .from("evaluation_runs")
      .select("id, sha, trigger, status, score, summary, queued_at")
      .eq("submission_id", s.id)
      .order("queued_at", { ascending: false })
      .limit(20),
    s.final_sha
      ? supabase
          .from("submission_snapshots")
          .select("id, tarball_sha256")
          .eq("submission_id", s.id)
          .eq("sha", s.final_sha)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    // Staff always; the student once grades are released (RLS).
    supabase
      .from("review_comments")
      .select("id, sha, path, line, body")
      .eq("submission_id", s.id)
      .order("path")
      .order("line"),
  ]);
  const codeComments = (reviewComments.data ?? []) as {
    id: string;
    sha: string;
    path: string;
    line: number;
    body: string;
  }[];
  const runList = (runs.data ?? []) as RunSummary[];

  // Grading (staff): rubric, feedback and every grade version.
  const [criteria, scores, feedback, grades, reasons, reports] = isCourseStaff
    ? await Promise.all([
        supabase
          .from("assignment_criteria")
          .select("id, title, description, max_points")
          .eq("assignment_id", a.id)
          .order("position"),
        supabase.from("rubric_scores").select("criterion_id, points, comment").eq("submission_id", s.id),
        supabase.from("feedback").select("body_md").eq("submission_id", s.id).maybeSingle(),
        supabase.from("grades").select(GRADE_COLUMNS).eq("submission_id", s.id).order("version", { ascending: false }),
        supabase.rpc("grade_override_reasons", { p_submission: s.id }),
        supabase
          .from("grade_reports")
          .select("id, version, grade_version, generated_at, sha256")
          .eq("submission_id", s.id)
          .order("version", { ascending: false }),
      ])
    : [null, null, null, null, null, null];
  const reportList = (reports?.data ?? []) as {
    id: string;
    version: number;
    grade_version: number;
    generated_at: string;
    sha256: string;
  }[];
  const gradeVersions = (grades?.data ?? []) as unknown as GradeRow[];
  const currentGrade = gradeVersions[0];
  const overrideReasons = new Map(
    ((reasons?.data ?? []) as { version: number; override_reason: string | null }[]).map((r) => [
      r.version,
      r.override_reason,
    ]),
  );
  const scoreByCriterion = new Map(
    ((scores?.data ?? []) as { criterion_id: string; points: string; comment: string | null }[]).map((r) => [
      r.criterion_id,
      r,
    ]),
  );
  const gradingIds = { slug, courseId: course.id, assignmentId: a.id, submissionId: s.id };
  const policy = policyRow.data?.process_policy as ProcessPolicy;
  const deadline = new Date(extension.data?.due_at ?? a.due_at);
  const repoUrl = s.repository ? `https://github.com/${s.repository.owner}/${s.repository.name}` : null;
  const name = s.profile?.full_name ?? s.profile?.email ?? "Student";

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-muted">
          <Link href={`/i/${slug}/courses/${course.id}/assignments/${a.id}`} className="hover:text-text">
            {a.title}
          </Link>
        </p>
        <h2 className="mt-1 text-xl font-semibold">
          {isCourseStaff ? (
            <Link href={`/i/${slug}/students/${s.user_id}`} className="hover:text-accent">
              {name}
            </Link>
          ) : (
            name
          )}
        </h2>
        <p className="mt-1 text-sm text-muted">
          {s.profile?.github_login && `@${s.profile.github_login} · `}
          {repoUrl ? (
            <a href={repoUrl} className="text-accent hover:underline">
              {s.repository!.owner}/{s.repository!.name}
            </a>
          ) : (
            "no repository yet"
          )}
          {" · "}
          {isCourseStaff && s.repository && (
            <>
              <Link
                href={`/i/${slug}/courses/${course.id}/assignments/${a.id}/submissions/${s.id}/code`}
                className="text-accent hover:underline"
              >
                Review code
              </Link>
              {" · "}
            </>
          )}
          {"due "}
          {formatInZone(deadline, course.timezone)}
          {extension.data && " (extended)"}
        </p>
        {s.finalized_at && (
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm">
            {s.final_sha ? (
              <>
                Graded commit{" "}
                {repoUrl ? (
                  <a href={`${repoUrl}/commit/${s.final_sha}`} className="font-mono text-accent hover:underline">
                    {s.final_sha.slice(0, 7)}
                  </a>
                ) : (
                  <span className="font-mono">{s.final_sha.slice(0, 7)}</span>
                )}
                , pushed {s.submitted_at && formatInZone(s.submitted_at, course.timezone)}
                {archive.data && (
                  <span className="text-muted">
                    · archived source:{" "}
                    <a
                      href={`/i/${slug}/snapshots/${archive.data.id}/tarball`}
                      className="text-accent hover:underline"
                      title={`SHA-256 ${archive.data.tarball_sha256}`}
                    >
                      tar.gz
                    </a>{" "}
                    ·{" "}
                    <a href={`/i/${slug}/snapshots/${archive.data.id}/bundle`} className="text-accent hover:underline">
                      git bundle
                    </a>
                  </span>
                )}
                {s.late_days ? (
                  <Badge tone="warning">
                    {s.late_days} day{s.late_days === 1 ? "" : "s"} late
                  </Badge>
                ) : (
                  <Badge tone="success">on time</Badge>
                )}
              </>
            ) : (
              <Badge tone="danger">nothing pushed before the cutoff</Badge>
            )}
          </p>
        )}
      </div>

      {isCourseStaff && (
        <Card
          title="Grading"
          description={
            currentGrade
              ? `Version ${currentGrade.version} · ${formatInZone(currentGrade.created_at, course.timezone)}`
              : "The grade is calculated once the graded commit is fixed at the cutoff."
          }
        >
          <div className="grid gap-8 lg:grid-cols-2">
            <div className="space-y-6">
              {currentGrade ? <GradeBreakdown grade={currentGrade} staff /> : <EmptyState title="No grade yet" />}
              {canManage && s.finalized_at && (
                <div className="border-t border-border pt-4">
                  <h3 className="mb-2 text-sm font-medium">Override</h3>
                  <OverrideForm
                    ids={gradingIds}
                    current={
                      currentGrade?.override_score != null
                        ? {
                            score: Number(currentGrade.override_score),
                            reason: overrideReasons.get(currentGrade.version) ?? "",
                          }
                        : null
                    }
                  />
                </div>
              )}
              {reportList.length > 0 && (
                <div className="border-t border-border pt-4 text-sm">
                  <h3 className="mb-2 font-medium">Grade reports</h3>
                  <ul className="space-y-1">
                    {reportList.map((r) => (
                      <li key={r.id} className="flex flex-wrap items-center gap-x-3">
                        <span>
                          v{r.version} · grade v{r.grade_version} · {formatInZone(r.generated_at, course.timezone)}
                        </span>
                        <a href={`/i/${slug}/reports/${r.id}/pdf`} className="text-accent hover:underline">
                          PDF
                        </a>
                        <a href={`/i/${slug}/reports/${r.id}/json`} className="text-accent hover:underline">
                          JSON
                        </a>
                        <span className="font-mono text-xs text-muted" title="SHA-256 of the JSON record">
                          {r.sha256.slice(0, 12)}…
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {gradeVersions.length > 1 && (
                <details className="border-t border-border pt-4 text-sm">
                  <summary className="cursor-pointer font-medium">Earlier versions</summary>
                  <ul className="mt-2 space-y-1 text-muted">
                    {gradeVersions.slice(1).map((g) => (
                      <li key={g.id}>
                        v{g.version} · {fmt(g.final_score)}
                        {g.override_score !== null && ` (override: ${overrideReasons.get(g.version) ?? ""})`} ·{" "}
                        {formatInZone(g.created_at, course.timezone)}
                        {g.released_at && " · released"}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
            <div>
              {(criteria?.data ?? []).length === 0 && (
                <p className="mb-3 text-sm text-muted">This assignment has no rubric criteria.</p>
              )}
              <ReviewForm
                ids={gradingIds}
                feedback={feedback?.data?.body_md ?? ""}
                criteria={(
                  (criteria?.data ?? []) as {
                    id: string;
                    title: string;
                    description: string | null;
                    max_points: string;
                  }[]
                ).map((c) => ({
                  id: c.id,
                  title: c.title,
                  description: c.description,
                  maxPoints: Number(c.max_points),
                  points: scoreByCriterion.has(c.id) ? Number(scoreByCriterion.get(c.id)!.points) : null,
                  comment: scoreByCriterion.get(c.id)?.comment ?? null,
                }))}
              />
            </div>
          </div>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="lg:col-span-2">
          <Card
            title="Process score"
            description={
              snapshot.data
                ? `${snapshot.data.is_final ? "Final" : "Updated"} ${formatInZone(snapshot.data.computed_at, course.timezone)}`
                : undefined
            }
          >
            {snapshot.data ? (
              <ProcessBreakdown result={snapshot.data.breakdown as ProcessResult} weightInGrade={a.weights.process} />
            ) : (
              <EmptyState title="No activity yet" />
            )}
          </Card>
          {canManage && (
            <div className="mt-6">
              <Card
                title="Extension"
                description={
                  extension.data
                    ? `Due ${formatInZone(extension.data.due_at, course.timezone)} for this student${extension.data.reason ? ` · ${extension.data.reason}` : ""}`
                    : `Graded commit fixed at ${formatInZone(submissionCutoff(new Date(a.due_at), a.late_policy), course.timezone)}`
                }
              >
                <ExtensionForm
                  slug={slug}
                  courseId={course.id}
                  assignmentId={a.id}
                  submissionId={s.id}
                  studentId={s.user_id}
                  timezone={course.timezone}
                  current={extension.data ? utcToZonedLocal(new Date(extension.data.due_at), course.timezone) : null}
                />
              </Card>
            </div>
          )}
        </div>

        <div className="space-y-6 lg:col-span-3">
          {codeComments.length > 0 && (
            <Card title="Code review" description={`${codeComments.length} comment(s) on your code`}>
              <ul className="divide-y divide-border text-sm" data-testid="code-comments">
                {codeComments.map((c) => (
                  <li key={c.id} className="py-2">
                    <a
                      href={
                        isCourseStaff
                          ? `/i/${slug}/courses/${course.id}/assignments/${a.id}/submissions/${s.id}/code?sha=${c.sha}&path=${encodeURIComponent(c.path)}&line=${c.line}#L${c.line}`
                          : `${repoUrl}/blob/${c.sha}/${c.path}#L${c.line}`
                      }
                      className="font-mono text-xs text-accent hover:underline"
                    >
                      {c.path}:{c.line}
                    </a>
                    <p className="whitespace-pre-wrap">{c.body}</p>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card title="Test runs" description={a.suite ? a.suite.title : "No automated tests for this assignment"}>
            <AutoRefresh active={runList.some((r) => isActive(r.status))} />
            {runList.length === 0 ? (
              <EmptyState title="No test runs yet">
                {a.triggers.on_push ? "Tests run automatically when you push to the default branch." : undefined}
              </EmptyState>
            ) : (
              <RunList
                runs={runList}
                timezone={course.timezone}
                href={(id) => `/i/${slug}/courses/${course.id}/assignments/${a.id}/submissions/${s.id}/runs/${id}`}
              />
            )}
            {a.suite && a.status === "published" && s.status === "active" && (isCourseStaff || a.triggers.manual) && (
              <div className="mt-4 border-t border-border pt-4">
                <RunTestsForm slug={slug} courseId={course.id} assignmentId={a.id} submissionId={s.id} />
              </div>
            )}
          </Card>

          <Card title="Commits" description={`${(commits.data ?? []).length} pushed`}>
            {(commits.data ?? []).length === 0 ? (
              <EmptyState title="No commits yet" />
            ) : (
              <ul className="divide-y divide-border">
                {(commits.data ?? []).map((c) => {
                  const verdict =
                    c.details_status === "unavailable"
                      ? { meaningful: false as const, reason: "unavailable" }
                      : classifyCommit(
                          {
                            sha: c.sha,
                            authoredAt: new Date(c.authored_at),
                            byStudent: c.author_profile_id === s.user_id,
                            isBot: c.is_bot,
                            parentCount: c.parent_count,
                            effectiveLines: c.details_status === "done" ? c.effective_lines : null,
                          },
                          policy,
                          deadline,
                        );
                  return (
                    <li key={c.sha} className="flex flex-wrap items-start justify-between gap-2 py-2 text-sm">
                      <div className="min-w-0">
                        <p className="truncate">{c.message.split("\n")[0]}</p>
                        <p className="text-xs text-muted">
                          {repoUrl ? (
                            <a href={`${repoUrl}/commit/${c.sha}`} className="font-mono hover:underline">
                              {c.sha.slice(0, 7)}
                            </a>
                          ) : (
                            <span className="font-mono">{c.sha.slice(0, 7)}</span>
                          )}
                          {" · "}
                          {formatInZone(c.authored_at, course.timezone)}
                          {c.author_login && ` · ${c.author_login}`}
                          {c.effective_lines !== null && ` · ${c.effective_lines} lines`}
                        </p>
                      </div>
                      {verdict.meaningful ? (
                        <Badge tone="success">counts</Badge>
                      ) : (
                        <Badge tone={verdict.reason === "pending" ? "neutral" : "warning"}>
                          {REASON[verdict.reason] ?? verdict.reason}
                        </Badge>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <div className="grid gap-6 sm:grid-cols-2">
            <Card title="Pull requests">
              {(prs.data ?? []).length === 0 ? (
                <EmptyState title="None yet" />
              ) : (
                <ul className="divide-y divide-border">
                  {(prs.data ?? []).map((p) => (
                    <li key={p.number} className="py-2 text-sm">
                      <p className="flex items-center justify-between gap-2">
                        <span className="truncate">
                          #{p.number} {p.title}
                        </span>
                        <Badge tone={p.state === "merged" ? "success" : p.state === "open" ? "accent" : "neutral"}>
                          {p.state}
                        </Badge>
                      </p>
                      <p className="text-xs text-muted">
                        {p.linked_issues.length
                          ? `closes ${p.linked_issues.map((n: number) => `#${n}`).join(", ")}`
                          : "no linked issue"}
                        {` · ${p.review_count} review${p.review_count === 1 ? "" : "s"}`}
                        {p.body_length < 20 && " · no description"}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title="Issues">
              {(issues.data ?? []).length === 0 ? (
                <EmptyState title="None yet" />
              ) : (
                <ul className="divide-y divide-border">
                  {(issues.data ?? []).map((i) => (
                    <li key={i.number} className="flex items-center justify-between gap-2 py-2 text-sm">
                      <span className="truncate">
                        #{i.number} {i.title}
                      </span>
                      <Badge tone={i.state === "closed" ? "success" : "accent"}>{i.state}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
