import {
  assessStudentRisk,
  distribution,
  median,
  MIN_COHORT,
  riskFlags,
  type FinishedAssignment,
  type RiskAssessment,
} from "@hbe/core";
import { sql, type Db } from "@hbe/db";

/**
 * Analytics for course staff (Phase 3B). Everything is computed from the records the platform
 * already keeps; nothing here is stored, and none of it affects a grade.
 */

const FAILED = ["failed", "error"];
const DAY_MS = 86_400_000;
/** The heat-map shows at most this many days, ending at the deadline (or today, if earlier). */
const HEATMAP_DAYS = 21;
/** …and the tests that fail most, at most this many. */
const HEATMAP_TESTS = 30;

export interface AssignmentAnalytics {
  summary: {
    submissions: number;
    started: number;
    tested: number;
    medianTestScore: number | null;
    graded: number;
    medianGrade: number | null;
    late: number;
    missing: number;
  };
  /** Each test on the latest completed run of each submission, the most failed first. */
  tests: { key: string; title: string; stage: string; total: number; failing: number }[];
  /** Days (in the course's time zone) by tests: runs that day, and how many failed the test. */
  heatmap: { days: string[]; rows: { key: string; title: string; cells: { runs: number; failed: number }[] }[] };
  testScores: ReturnType<typeof distribution>;
  grades: ReturnType<typeof distribution>;
}

export async function assignmentAnalytics(
  db: Db,
  assignmentId: string,
  now = new Date(),
): Promise<AssignmentAnalytics> {
  const a = await db
    .selectFrom("assignments as a")
    .innerJoin("courses as c", "c.id", "a.course_id")
    .select(["a.id", "a.due_at", "a.published_at", "a.created_at", "c.timezone"])
    .where("a.id", "=", assignmentId)
    .executeTakeFirstOrThrow();

  const { rows: subs } = await sql<{
    submission_id: string;
    status: string;
    late_days: number | null;
    finalized_at: Date | null;
    latest_run_id: string | null;
    latest_run_score: string | null;
    final_score: string | null;
    last_activity_at: Date | null;
  }>`select submission_id, status, late_days, finalized_at, latest_run_id, latest_run_score, final_score, last_activity_at
     from submission_overview where assignment_id = ${assignmentId}`.execute(db);

  const latestRuns = subs.map((s) => s.latest_run_id).filter((id): id is string => !!id);
  const testScores = subs.filter((s) => s.latest_run_score !== null).map((s) => Number(s.latest_run_score));
  const grades = subs.filter((s) => s.final_score !== null).map((s) => Number(s.final_score));

  const { rows: tests } = latestRuns.length
    ? await sql<{ key: string; title: string; stage: string; total: number; failing: number }>`
        select test_key as key, max(title) as title, max(stage) as stage, count(*)::int as total,
               count(*) filter (where status = any (${FAILED}))::int as failing
        from test_results where run_id = any (${latestRuns}::uuid[])
        group by test_key order by failing desc, total desc, test_key`.execute(db)
    : { rows: [] };

  // The heat-map's days, ending at the deadline (or today), never before the assignment opened.
  const tz = a.timezone;
  const end = new Date(Math.min(now.getTime(), new Date(a.due_at).getTime()));
  const opened = new Date(a.published_at ?? a.created_at);
  const dayOf = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
  const days: string[] = [];
  for (let t = end.getTime(); days.length < HEATMAP_DAYS && t >= opened.getTime() - DAY_MS; t -= DAY_MS) {
    const d = dayOf(new Date(t));
    if (!days.includes(d)) days.unshift(d);
  }
  const shown = tests.slice(0, HEATMAP_TESTS);
  const { rows: cells } =
    shown.length && days.length
      ? await sql<{ day: string; key: string; runs: number; failed: number }>`
          select to_char((r.finished_at at time zone ${tz})::date, 'YYYY-MM-DD') as day, t.test_key as key,
                 count(*)::int as runs, count(*) filter (where t.status = any (${FAILED}))::int as failed
          from test_results t
          join evaluation_runs r on r.id = t.run_id
          join submissions s on s.id = r.submission_id
          where s.assignment_id = ${assignmentId} and r.status = 'completed'
            and t.test_key = any (${shown.map((x) => x.key)})
            and (r.finished_at at time zone ${tz})::date between ${days[0]}::date and ${days.at(-1)}::date
          group by 1, 2`.execute(db)
      : { rows: [] };
  const byCell = new Map(cells.map((c) => [`${c.key}|${c.day}`, c]));

  return {
    summary: {
      submissions: subs.length,
      started: subs.filter((s) => s.last_activity_at).length,
      tested: testScores.length,
      medianTestScore: median(testScores),
      graded: grades.length,
      medianGrade: median(grades),
      late: subs.filter((s) => (s.late_days ?? 0) > 0).length,
      missing: subs.filter((s) => s.status === "missing").length,
    },
    tests,
    heatmap: {
      days,
      rows: shown.map((t) => ({
        key: t.key,
        title: t.title,
        cells: days.map((d) => {
          const c = byCell.get(`${t.key}|${d}`);
          return { runs: c?.runs ?? 0, failed: c?.failed ?? 0 };
        }),
      })),
    },
    testScores: distribution(testScores),
    grades: distribution(grades),
  };
}

export interface StudentRisk extends RiskAssessment {
  userId: string;
  name: string;
}

/** Students of a course who may need help, with the reasons; the most concerning first. */
export async function courseAtRisk(db: Db, courseId: string, now = new Date()): Promise<StudentRisk[]> {
  const { rows: students } = await sql<{ user_id: string; name: string }>`
    select cm.user_id, coalesce(p.full_name, p.email, 'Unknown') as name
    from course_memberships cm
    join institution_memberships m on m.institution_id = cm.institution_id and m.user_id = cm.user_id
    join profiles p on p.id = cm.user_id
    where cm.course_id = ${courseId} and cm.role = 'student' and m.status = 'active' and p.anonymised_at is null`.execute(
    db,
  );
  const { rows: assignments } = await sql<{ id: string; title: string; due_at: Date }>`
    select id, title, due_at from assignments where course_id = ${courseId} and status <> 'draft' order by due_at`.execute(
    db,
  );
  const { rows: subs } = await sql<{
    user_id: string;
    assignment_id: string;
    status: string;
    repository_id: string | null;
    late_days: number | null;
    finalized_at: Date | null;
    last_activity_at: Date | null;
    latest_run_score: string | null;
    final_score: string | null;
    created_at: Date;
    process_score: string | null;
  }>`
    select o.user_id, o.assignment_id, o.status, o.repository_id, o.late_days, o.finalized_at, o.last_activity_at,
           o.latest_run_score, o.final_score, o.created_at,
           (select ps.score from process_snapshots ps where ps.submission_id = o.submission_id
            order by ps.is_final desc, ps.computed_at desc limit 1) as process_score
    from submission_overview o where o.course_id = ${courseId}`.execute(db);
  const { rows: extensions } = await sql<{ assignment_id: string; user_id: string; due_at: Date }>`
    select e.assignment_id, e.user_id, e.due_at from assignment_extensions e
    join assignments a on a.id = e.assignment_id where a.course_id = ${courseId}`.execute(db);
  const sub = new Map(subs.map((s) => [`${s.user_id}|${s.assignment_id}`, s]));
  const ext = new Map(extensions.map((e) => [`${e.user_id}|${e.assignment_id}`, new Date(e.due_at)]));

  const result: StudentRisk[] = [];
  for (const st of students) {
    const finished: FinishedAssignment[] = [];
    const current: string[] = [];
    for (const a of assignments) {
      const s = sub.get(`${st.user_id}|${a.id}`);
      if (!s) continue;
      if (s.finalized_at) {
        finished.push({
          title: a.title,
          score: s.final_score === null ? null : Number(s.final_score),
          lateDays: s.late_days ?? 0,
          missing: s.status === "missing",
          processScore: s.process_score === null ? null : Number(s.process_score),
        });
      } else {
        const flags = riskFlags({
          now,
          deadline: ext.get(`${st.user_id}|${a.id}`) ?? new Date(a.due_at),
          finalized: false,
          hasRepository: Boolean(s.repository_id),
          lastActivityAt: s.last_activity_at ? new Date(s.last_activity_at) : null,
          startedAt: new Date(s.created_at),
          latestScore: s.latest_run_score === null ? null : Number(s.latest_run_score),
        });
        current.push(...flags.map((f) => `${a.title}: ${f}`));
      }
    }
    const assessment = assessStudentRisk({ finished, current });
    if (assessment.level) result.push({ userId: st.user_id, name: st.name, ...assessment });
  }
  const rank = { high: 0, medium: 1 } as const;
  return result.sort(
    (x, y) => rank[x.level!] - rank[y.level!] || y.reasons.length - x.reasons.length || x.name.localeCompare(y.name),
  );
}

export interface CohortTerm {
  courseId: string;
  term: string;
  /** This course (the one asked about). */
  current: boolean;
  students: number;
}

export interface CohortAssignment {
  slug: string;
  title: string;
  terms: {
    courseId: string;
    term: string;
    submissions: number;
    /** Withheld when fewer than MIN_COHORT students took part. */
    suppressed: boolean;
    medianGrade: number | null;
    meanGrade: number | null;
    medianTestScore: number | null;
    onTimeRate: number | null;
    missingRate: number | null;
    mostFailed: { title: string; rate: number }[];
  }[];
}

/**
 * The same course (by code) across terms, assignment by assignment (by slug): sizes, grades,
 * test scores, punctuality and the most failed tests. Aggregates only; a term with fewer than
 * MIN_COHORT students shows its size and nothing else.
 */
export async function courseCohorts(
  db: Db,
  courseId: string,
): Promise<{ code: string; terms: CohortTerm[]; assignments: CohortAssignment[] }> {
  const course = await db
    .selectFrom("courses")
    .select(["institution_id", "code"])
    .where("id", "=", courseId)
    .executeTakeFirstOrThrow();
  const { rows: courses } = await sql<{ id: string; term: string; created_at: Date; students: number }>`
    select c.id, c.term, c.created_at,
           (select count(*)::int from course_memberships cm where cm.course_id = c.id and cm.role = 'student') as students
    from courses c where c.institution_id = ${course.institution_id} and lower(c.code) = lower(${course.code})
    order by c.created_at`.execute(db);
  const ids = courses.map((c) => c.id);
  const { rows: assignments } = await sql<{ id: string; course_id: string; slug: string; title: string; due_at: Date }>`
    select id, course_id, slug, title, due_at from assignments
    where course_id = any (${ids}::uuid[]) and status <> 'draft' order by due_at`.execute(db);
  const { rows: subs } = await sql<{
    assignment_id: string;
    status: string;
    late_days: number | null;
    finalized_at: Date | null;
    latest_run_id: string | null;
    latest_run_score: string | null;
    final_score: string | null;
  }>`select assignment_id, status, late_days, finalized_at, latest_run_id, latest_run_score, final_score
     from submission_overview where course_id = any (${ids}::uuid[])`.execute(db);

  const bySlug = new Map<string, CohortAssignment>();
  for (const a of assignments) {
    const entry = bySlug.get(a.slug) ?? { slug: a.slug, title: a.title, terms: [] };
    bySlug.set(a.slug, entry);
    const course = courses.find((c) => c.id === a.course_id)!;
    const mine = subs.filter((s) => s.assignment_id === a.id);
    const suppressed = mine.length < MIN_COHORT;
    const finalized = mine.filter((s) => s.finalized_at);
    const submitted = finalized.filter((s) => s.status !== "missing");
    const grades = mine.filter((s) => s.final_score !== null).map((s) => Number(s.final_score));
    const scores = mine.filter((s) => s.latest_run_score !== null).map((s) => Number(s.latest_run_score));
    let mostFailed: { title: string; rate: number }[] = [];
    const runs = mine.map((s) => s.latest_run_id).filter((id): id is string => !!id);
    if (!suppressed && runs.length) {
      const { rows } = await sql<{ title: string; total: number; failing: number }>`
        select max(title) as title, count(*)::int as total, count(*) filter (where status = any (${FAILED}))::int as failing
        from test_results where run_id = any (${runs}::uuid[])
        group by test_key having count(*) filter (where status = any (${FAILED})) > 0
        order by 3 desc, 2 desc limit 3`.execute(db);
      mostFailed = rows.map((r) => ({ title: r.title, rate: r.failing / r.total }));
    }
    const round = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10);
    entry.terms.push({
      courseId: course.id,
      term: course.term,
      submissions: mine.length,
      suppressed,
      medianGrade: suppressed ? null : round(median(grades)),
      meanGrade: suppressed || !grades.length ? null : round(grades.reduce((s, g) => s + g, 0) / grades.length),
      medianTestScore: suppressed ? null : round(median(scores)),
      onTimeRate:
        suppressed || !submitted.length ? null : submitted.filter((s) => !s.late_days).length / submitted.length,
      missingRate:
        suppressed || !finalized.length
          ? null
          : finalized.filter((s) => s.status === "missing").length / finalized.length,
      mostFailed,
    });
  }
  return {
    code: course.code,
    terms: courses.map((c) => ({ courseId: c.id, term: c.term, current: c.id === courseId, students: c.students })),
    // Only assignments that more than one term had are a comparison.
    assignments: [...bySlug.values()].filter((a) => a.terms.length > 1),
  };
}
