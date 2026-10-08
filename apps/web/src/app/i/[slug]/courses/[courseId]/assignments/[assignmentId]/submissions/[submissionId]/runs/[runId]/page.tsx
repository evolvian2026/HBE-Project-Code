import { formatInZone } from "@hbe/core";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AutoRefresh } from "@/components/auto-refresh";
import { isActive, RunStatusBadge, type RunStatus } from "@/components/evaluation";
import { Alert, Badge, Card, EmptyState } from "@/components/ui";
import { loadAssignment } from "../../../../../data";

type Props = {
  params: Promise<{ slug: string; courseId: string; assignmentId: string; submissionId: string; runId: string }>;
};

export const metadata: Metadata = { title: "Test run" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const STAGE_LABEL: Record<string, string> = {
  contract: "Project structure",
  build: "Build",
  health: "App starts",
  api: "API tests",
  e2e: "Browser tests",
};

const TEST_TONE = { passed: "success", failed: "danger", error: "warning", skipped: "neutral" } as const;
const ORDER = { failed: 0, error: 1, skipped: 2, passed: 3 } as const;

interface Stage {
  key: string;
  status: keyof typeof TEST_TONE;
  duration_ms: number;
  message?: string;
}

interface TestRow {
  id: string;
  stage: string;
  test_key: string;
  title: string;
  category: string | null;
  status: keyof typeof TEST_TONE;
  weight: string;
  expected: string | null;
  actual: string | null;
  message: string | null;
  hint: string | null;
  evidence: Record<string, string> | null;
}

const EVIDENCE_LABEL: Record<string, string> = { request: "Request", response: "Response", logs: "Your app's logs" };
const seconds = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

export default async function RunPage({ params }: Props) {
  const { slug, courseId, assignmentId, submissionId, runId } = await params;
  const { course, supabase, isCourseStaff, assignment: a } = await loadAssignment(slug, courseId, assignmentId);
  if (!UUID.test(submissionId) || !UUID.test(runId)) notFound();

  // Columns are listed explicitly: the callback token hash is not readable.
  const { data: run } = await supabase
    .from("evaluation_runs")
    .select("id, sha, trigger, status, score, summary, error, queued_at, started_at, finished_at")
    .eq("id", runId)
    .eq("submission_id", submissionId)
    .maybeSingle();
  if (!run) notFound(); // RLS: the student and course staff only

  const [tests, submission, notes] = await Promise.all([
    supabase
      .from("test_results")
      .select("id, stage, test_key, title, category, status, weight, expected, actual, message, hint, evidence")
      .eq("run_id", run.id),
    supabase
      .from("submissions")
      .select("user_id, profile:profiles(full_name, email), repository:repositories(owner, name)")
      .eq("id", submissionId)
      .maybeSingle(),
    isCourseStaff
      ? supabase.rpc("run_staff_notes", { p_run_id: run.id })
      : Promise.resolve({ data: [] as { stage: string; test_key: string; staff_notes: string }[] }),
  ]);
  const sub = submission.data as unknown as {
    profile: { full_name: string | null; email: string | null } | null;
    repository: { owner: string; name: string } | null;
  } | null;
  const staffNotes = new Map(
    ((notes.data ?? []) as { stage: string; test_key: string; staff_notes: string }[]).map((n) => [
      `${n.stage}/${n.test_key}`,
      n.staff_notes,
    ]),
  );
  const status = run.status as RunStatus;
  const summary = (run.summary ?? {}) as {
    stages?: Stage[];
    passed?: number;
    total?: number;
    blockedBy?: string | null;
  };
  const stages = summary.stages ?? [];
  const rows = ((tests.data ?? []) as TestRow[]).sort(
    (x, y) => ORDER[x.status] - ORDER[y.status] || x.title.localeCompare(y.title),
  );
  const repoUrl = sub?.repository ? `https://github.com/${sub.repository.owner}/${sub.repository.name}` : null;
  const submissionHref = `/i/${slug}/courses/${course.id}/assignments/${a.id}/submissions/${submissionId}`;

  return (
    <div className="space-y-6">
      <AutoRefresh active={isActive(status)} />
      <div>
        <p className="text-sm text-muted">
          <Link href={`/i/${slug}/courses/${course.id}/assignments/${a.id}`} className="hover:text-text">
            {a.title}
          </Link>
          {" › "}
          <Link href={submissionHref} className="hover:text-text">
            {isCourseStaff ? (sub?.profile?.full_name ?? sub?.profile?.email ?? "Submission") : "Your submission"}
          </Link>
        </p>
        <h2 className="mt-1 flex flex-wrap items-center gap-2 text-xl font-semibold">
          Test run <RunStatusBadge status={status} />
        </h2>
        <p className="mt-1 text-sm text-muted">
          Commit{" "}
          {repoUrl ? (
            <a href={`${repoUrl}/commit/${run.sha}`} className="font-mono text-accent hover:underline">
              {run.sha.slice(0, 7)}
            </a>
          ) : (
            <span className="font-mono">{run.sha.slice(0, 7)}</span>
          )}
          {" · started by "}
          {run.trigger === "manual" ? "request" : run.trigger.replace("_", " ")}
          {" · "}
          {formatInZone(run.queued_at, course.timezone)}
        </p>
      </div>

      {isActive(status) && (
        <Alert tone="info">
          {status === "queued"
            ? "Waiting for a grader. This page updates by itself."
            : "The tests are running. This page updates by itself."}
        </Alert>
      )}
      {status === "infra_error" && (
        <Alert tone="error">
          <p>The grader hit a platform problem, not a problem with your code. This run doesn&apos;t count.</p>
          {run.error && <p className="mt-1 text-sm">{run.error}</p>}
        </Alert>
      )}
      {status === "cancelled" && <Alert tone="info">{run.error ?? "This run was cancelled."}</Alert>}

      {status === "completed" && (
        <div className="grid gap-6 lg:grid-cols-3">
          <Card title="Score">
            <p className="text-3xl font-semibold tabular-nums">
              {run.score === null ? "–" : Math.round(Number(run.score))}
              <span className="text-base font-normal text-muted"> / 100</span>
            </p>
            <p className="mt-1 text-sm text-muted">
              {summary.blockedBy
                ? `Tests could not run: the ${STAGE_LABEL[summary.blockedBy] ?? summary.blockedBy} step failed.`
                : `${summary.passed ?? 0} of ${summary.total ?? 0} tests passed.`}{" "}
              Automated tests are {a.weights.automated}% of the grade.
            </p>
          </Card>
          <div className="lg:col-span-2">
            <Card title="Steps">
              <ol className="space-y-3">
                {stages.map((s) => (
                  <li key={s.key} className="text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{STAGE_LABEL[s.key] ?? s.key}</span>
                      <span className="flex items-center gap-2 text-muted">
                        {s.duration_ms > 0 && <span className="tabular-nums">{seconds(s.duration_ms)}</span>}
                        <Badge tone={TEST_TONE[s.status] ?? "neutral"}>{s.status}</Badge>
                      </span>
                    </div>
                    {s.message && s.status === "failed" && (
                      <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-surface-2 p-3 text-xs">
                        {s.message}
                      </pre>
                    )}
                  </li>
                ))}
              </ol>
            </Card>
          </div>
        </div>
      )}

      {rows.length > 0 && (
        <Card title="Tests" description="Failed tests first. Each one says what was expected and what your app did.">
          <ul className="divide-y divide-border">
            {rows.map((t) => {
              const note = staffNotes.get(`${t.stage}/${t.test_key}`);
              const open = t.status === "failed" || t.status === "error";
              return (
                <li key={t.id} className="py-3 text-sm" data-testid={`test-${t.test_key}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">
                      {t.title}
                      {t.category && <span className="font-normal text-muted"> · {t.category}</span>}
                    </span>
                    <span className="flex items-center gap-2 text-muted">
                      <span className="tabular-nums">
                        {Number(t.weight)} pt{Number(t.weight) === 1 ? "" : "s"}
                      </span>
                      <Badge tone={TEST_TONE[t.status]}>{t.status}</Badge>
                    </span>
                  </div>
                  {open && (
                    <div className="mt-2 space-y-2">
                      {t.message && <p>{t.message}</p>}
                      {(t.expected || t.actual) && (
                        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                          <dt className="text-muted">Expected</dt>
                          <dd className="font-mono text-xs">{t.expected}</dd>
                          <dt className="text-muted">Actual</dt>
                          <dd className="font-mono text-xs">{t.actual}</dd>
                        </dl>
                      )}
                      {t.hint && (
                        <p className="rounded-md bg-accent/5 px-3 py-2">
                          <span className="font-medium">Hint: </span>
                          {t.hint}
                        </p>
                      )}
                      {t.evidence &&
                        Object.entries(t.evidence).map(([key, value]) => (
                          <details key={key}>
                            <summary className="cursor-pointer text-muted">{EVIDENCE_LABEL[key] ?? key}</summary>
                            <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-surface-2 p-3 text-xs">
                              {value}
                            </pre>
                          </details>
                        ))}
                      {note && (
                        <p className="rounded-md border border-warning/40 px-3 py-2">
                          <span className="font-medium">Staff note (students don&apos;t see this): </span>
                          {note}
                        </p>
                      )}
                    </div>
                  )}
                  {t.status === "skipped" && t.message && <p className="mt-1 text-muted">{t.message}</p>}
                </li>
              );
            })}
          </ul>
        </Card>
      )}
      {status === "completed" && rows.length === 0 && (
        <Card title="Tests">
          <EmptyState title="No tests were reported" />
        </Card>
      )}
    </div>
  );
}
