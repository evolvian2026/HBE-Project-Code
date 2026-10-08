import type { ProcessResult } from "@hbe/core";
import { sql, type Db } from "@hbe/db";

/**
 * Everything a grade report records (docs/ARCHITECTURE.md §12.2). The JSON form is the
 * record; the PDF renders it. Staff notes and override reasons stay out: students get the
 * report too.
 */
export interface ReportStage {
  key: string;
  status: string;
  duration_ms: number;
  message?: string;
}

export interface GradeReport {
  schema: "hbe.grade-report/1";
  report: { version: number; grade_version: number; generated_at: string };
  institution: { name: string };
  course: { code: string; name: string; term: string; timezone: string };
  assignment: {
    title: string;
    due_at: string;
    effective_due_at: string;
    extension: { due_at: string; reason: string | null } | null;
    weights: { automated: number; rubric: number; process: number };
    late_policy: { per_day_percent: number; max_days: number; grace_minutes: number };
    stack_profile: string;
    suite: string | null;
  };
  student: { name: string | null; email: string | null; github_login: string | null; student_id: string | null };
  submission: {
    status: string;
    repository: string | null;
    graded_commit: string | null;
    pushed_at: string | null;
    late_days: number;
    snapshot: { bundle_sha256: string; tarball_sha256: string } | null;
  };
  automated: {
    run_id: string;
    score: number | null;
    finished_at: string | null;
    stages: ReportStage[];
    tests: {
      stage: string;
      id: string;
      title: string;
      category: string | null;
      status: string;
      weight: number;
      expected: string | null;
      actual: string | null;
      message: string | null;
      hint: string | null;
    }[];
  } | null;
  rubric: { criterion: string; max_points: number; points: number | null; comment: string | null }[];
  feedback_md: string;
  process: { score: number; criteria: { label: string; points: number; explanation: string }[] } | null;
  grade: {
    components: Record<string, unknown>;
    late_penalty_percent: number;
    computed: number;
    adjusted_by_staff: boolean;
    final: number;
    complete: boolean;
    released_at: string | null;
  };
}

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

/** Gathers a report for one grade version. `version` is the report's number for the submission. */
export async function buildGradeReport(db: Db, gradeId: string, version: number): Promise<GradeReport | null> {
  const g = await db
    .selectFrom("grades as g")
    .innerJoin("submissions as s", "s.id", "g.submission_id")
    .innerJoin("assignments as a", "a.id", "s.assignment_id")
    .innerJoin("courses as c", "c.id", "a.course_id")
    .innerJoin("institutions as i", "i.id", "g.institution_id")
    .innerJoin("profiles as p", "p.id", "g.user_id")
    .innerJoin("stack_profiles as sp", "sp.id", "a.stack_profile_id")
    .leftJoin("grader_suites as gs", "gs.id", "a.grader_suite_id")
    .leftJoin("repositories as r", "r.id", "s.repository_id")
    .leftJoin("institution_memberships as m", (j) =>
      j.onRef("m.institution_id", "=", "g.institution_id").onRef("m.user_id", "=", "g.user_id"),
    )
    .leftJoin("assignment_extensions as x", (j) =>
      j.onRef("x.assignment_id", "=", "a.id").onRef("x.user_id", "=", "s.user_id"),
    )
    .select([
      "g.id",
      "g.version as grade_version",
      "g.evaluation_run_id",
      "g.components",
      "g.late_days",
      "g.late_penalty",
      "g.computed_score",
      "g.override_score",
      "g.final_score",
      "g.complete",
      "g.released_at",
      "s.id as submission_id",
      "s.status",
      "s.final_sha",
      "s.submitted_at",
      "a.id as assignment_id",
      "a.title",
      "a.due_at",
      "a.weights",
      "a.late_policy",
      "c.code",
      "c.name as course_name",
      "c.term",
      "c.timezone",
      "i.name as institution_name",
      "p.full_name",
      "p.email",
      "p.github_login",
      "m.external_id",
      "x.due_at as extension_due_at",
      "x.reason as extension_reason",
      "sp.key as profile_key",
      "sp.version as profile_version",
      "gs.key as suite_key",
      "gs.version as suite_version",
      "r.owner",
      "r.name as repo_name",
    ])
    .where("g.id", "=", gradeId)
    .executeTakeFirst();
  if (!g) return null;

  const [run, tests, rubric, feedback, process, snapshot] = await Promise.all([
    g.evaluation_run_id
      ? db
          .selectFrom("evaluation_runs")
          .select(["id", "score", "summary", "finished_at"])
          .where("id", "=", g.evaluation_run_id)
          .executeTakeFirst()
      : undefined,
    g.evaluation_run_id
      ? db
          .selectFrom("test_results")
          .select([
            "stage",
            "test_key",
            "title",
            "category",
            "status",
            "weight",
            "expected",
            "actual",
            "message",
            "hint",
          ])
          .where("run_id", "=", g.evaluation_run_id)
          .orderBy("stage")
          .orderBy("test_key")
          .execute()
      : [],
    sql<{ title: string; max_points: string; points: string | null; comment: string | null }>`
      select c.title, c.max_points, r.points, r.comment
      from assignment_criteria c
      left join rubric_scores r on r.criterion_id = c.id and r.submission_id = ${g.submission_id}
      where c.assignment_id = ${g.assignment_id}
      order by c.position, c.created_at`.execute(db),
    db.selectFrom("feedback").select("body_md").where("submission_id", "=", g.submission_id).executeTakeFirst(),
    db
      .selectFrom("process_snapshots")
      .select(["score", "breakdown"])
      .where("submission_id", "=", g.submission_id)
      .executeTakeFirst(),
    g.final_sha
      ? db
          .selectFrom("submission_snapshots")
          .select(["bundle_sha256", "tarball_sha256"])
          .where("submission_id", "=", g.submission_id)
          .where("sha", "=", g.final_sha)
          .executeTakeFirst()
      : undefined,
  ]);

  const breakdown = process?.breakdown as unknown as ProcessResult | undefined;
  return {
    schema: "hbe.grade-report/1",
    report: { version, grade_version: g.grade_version, generated_at: new Date().toISOString() },
    institution: { name: g.institution_name },
    course: { code: g.code, name: g.course_name, term: g.term, timezone: g.timezone },
    assignment: {
      title: g.title,
      due_at: iso(g.due_at)!,
      effective_due_at: iso(g.extension_due_at ?? g.due_at)!,
      extension: g.extension_due_at ? { due_at: iso(g.extension_due_at)!, reason: g.extension_reason } : null,
      weights: g.weights as unknown as GradeReport["assignment"]["weights"],
      late_policy: g.late_policy as unknown as GradeReport["assignment"]["late_policy"],
      stack_profile: `${g.profile_key}@${g.profile_version}`,
      suite: g.suite_key ? `${g.suite_key}@${g.suite_version}` : null,
    },
    student: { name: g.full_name, email: g.email, github_login: g.github_login, student_id: g.external_id ?? null },
    submission: {
      status: g.status,
      repository: g.owner ? `${g.owner}/${g.repo_name}` : null,
      graded_commit: g.final_sha,
      pushed_at: iso(g.submitted_at),
      late_days: g.late_days,
      snapshot: snapshot ?? null,
    },
    automated: run
      ? {
          run_id: run.id,
          score: run.score === null ? null : Number(run.score),
          finished_at: iso(run.finished_at),
          stages: (run.summary as { stages?: ReportStage[] } | null)?.stages ?? [],
          tests: tests.map((t) => ({
            stage: t.stage,
            id: t.test_key,
            title: t.title,
            category: t.category,
            status: t.status,
            weight: Number(t.weight),
            expected: t.expected,
            actual: t.actual,
            message: t.message,
            hint: t.hint,
          })),
        }
      : null,
    rubric: rubric.rows.map((r) => ({
      criterion: r.title,
      max_points: Number(r.max_points),
      points: r.points === null ? null : Number(r.points),
      comment: r.comment,
    })),
    feedback_md: feedback?.body_md ?? "",
    process: breakdown
      ? {
          score: Number(process!.score),
          criteria: (breakdown.criteria ?? []).map((c) => ({
            label: c.label,
            points: c.points,
            explanation: c.explanation,
          })),
        }
      : null,
    grade: {
      components: g.components as Record<string, unknown>,
      late_penalty_percent: Number(g.late_penalty),
      computed: Number(g.computed_score),
      adjusted_by_staff: g.override_score !== null,
      final: Number(g.final_score),
      complete: g.complete,
      released_at: iso(g.released_at),
    },
  };
}
