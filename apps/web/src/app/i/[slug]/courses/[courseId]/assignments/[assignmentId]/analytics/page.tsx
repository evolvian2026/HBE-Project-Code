import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BarList, FailureHeatMap, percent, ScoreColumns, StatTiles, TableView } from "@/components/charts";
import { Card, EmptyState } from "@/components/ui";
import { type AssignmentAnalytics, shortDay } from "@/lib/analytics";
import { apiFetch } from "@/lib/api";
import { requireMembership } from "@/lib/institution";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Assignment analytics" };

type Props = { params: Promise<{ slug: string; courseId: string; assignmentId: string }> };

export default async function AssignmentAnalyticsPage({ params }: Props) {
  const { slug, courseId, assignmentId } = await params;
  const ctx = await requireMembership(slug);
  const supabase = await createSupabaseServerClient();
  const { data: a } = await supabase
    .from("assignments")
    .select("id, title, course:courses(code, name)")
    .eq("id", assignmentId)
    .eq("course_id", courseId)
    .eq("institution_id", ctx.institution.id)
    .maybeSingle();
  if (!a) notFound();
  const result = await apiFetch<AssignmentAnalytics>(`/v1/assignments/${assignmentId}/analytics`);
  if (!result.ok) notFound(); // course staff only
  const { summary: s, tests, heatmap, testScores, grades } = result.data;
  const course = a.course as unknown as { code: string; name: string };
  const back = `/i/${slug}/courses/${courseId}/assignments/${assignmentId}`;
  const number = (n: number | null) => (n === null ? "–" : String(Math.round(n)));

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-muted">
          <Link href={back} className="link">
            {a.title}
          </Link>{" "}
          · {course.code} {course.name}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Analytics</h1>
        <p className="mt-1 text-sm text-muted">For staff. Figures only; nothing here changes a grade.</p>
      </div>

      <StatTiles
        items={[
          { label: "Started", value: `${s.started} of ${s.submissions}`, note: "pushed at least once" },
          { label: "Median test score", value: number(s.medianTestScore), note: `${s.tested} with a test run` },
          { label: "Median grade", value: number(s.medianGrade), note: `${s.graded} graded` },
          { label: "Late or missing", value: `${s.late} · ${s.missing}`, note: "late · nothing submitted" },
        ]}
      />

      <Card
        title="Tests students fail"
        description="On each submission's latest test run: the share of submissions failing each hidden test."
      >
        {tests.length === 0 ? (
          <EmptyState title="No test runs yet" />
        ) : (
          <>
            <BarList
              label="Share of submissions failing each test"
              rows={tests.map((t) => ({
                key: t.key,
                name: t.title,
                value: t.failing / t.total,
                display: `${percent(t.failing / t.total)} (${t.failing})`,
                tip: `${t.title}: ${t.failing} of ${t.total} failing`,
              }))}
            />
            <TableView
              caption="Tests students fail"
              head={["Test", "Stage", "Failing", "Of", "Share"]}
              rows={tests.map((t) => [t.title, t.stage, t.failing, t.total, percent(t.failing / t.total)])}
            />
          </>
        )}
      </Card>

      <Card
        title="Failures over time"
        description="Each day's test runs: how many failed each test. The stronger the colour, the more runs failed; a test that stays strong as the deadline nears is worth a hint."
      >
        {heatmap.rows.length === 0 ? (
          <EmptyState title="No test runs yet" />
        ) : (
          <>
            <FailureHeatMap days={heatmap.days} rows={heatmap.rows} dayLabel={shortDay} />
            <TableView
              caption="Failures over time"
              head={["Test", ...heatmap.days.map(shortDay)]}
              rows={heatmap.rows.map((r) => [r.title, ...r.cells.map((c) => (c.runs ? `${c.failed}/${c.runs}` : "–"))])}
            />
          </>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Latest test scores" description="Each submission's latest test run.">
          {s.tested === 0 ? (
            <EmptyState title="No test runs yet" />
          ) : (
            <>
              <ScoreColumns label="Distribution of latest test scores" bins={testScores} unit="submissions" />
              <TableView
                caption="Latest test scores"
                head={["Score", "Submissions"]}
                rows={testScores.map((b) => [`${b.from}–${b.to === 100 ? 100 : b.to - 1}`, b.count])}
              />
            </>
          )}
        </Card>
        <Card title="Grades" description="Current grades, released or not.">
          {s.graded === 0 ? (
            <EmptyState title="No grades yet" />
          ) : (
            <>
              <ScoreColumns label="Distribution of grades" bins={grades} unit="students" />
              <TableView
                caption="Grades"
                head={["Grade", "Students"]}
                rows={grades.map((b) => [`${b.from}–${b.to === 100 ? 100 : b.to - 1}`, b.count])}
              />
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
