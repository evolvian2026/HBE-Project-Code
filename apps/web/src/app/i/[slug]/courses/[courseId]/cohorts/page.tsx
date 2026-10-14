import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChartTips } from "@/components/chart-tips";
import { percent, TableView } from "@/components/charts";
import { Badge, Card, EmptyState } from "@/components/ui";
import type { Cohorts } from "@/lib/analytics";
import { apiFetch } from "@/lib/api";
import { requireMembership } from "@/lib/institution";

export const metadata: Metadata = { title: "Compare terms" };

type Props = { params: Promise<{ slug: string; courseId: string }> };

const MIN_COHORT = 5;

export default async function CohortsPage({ params }: Props) {
  const { slug, courseId } = await params;
  await requireMembership(slug);
  const result = await apiFetch<Cohorts>(`/v1/courses/${courseId}/cohorts`);
  if (!result.ok) notFound(); // course staff only
  const { code, terms, assignments } = result.data;
  const one = (n: number | null) => (n === null ? "–" : n.toFixed(0));
  const rate = (n: number | null) => (n === null ? "–" : percent(n));

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-muted">
          <Link href={`/i/${slug}/courses/${courseId}`} className="link">
            {code}
          </Link>{" "}
          · {terms.length} {terms.length === 1 ? "term" : "terms"}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Compare terms</h1>
        <p className="mt-1 text-sm text-muted">
          The same assignment in each term of {code}. Aggregates only; a term with fewer than {MIN_COHORT} students
          shows only its size, so nobody can be singled out.
        </p>
      </div>

      {assignments.length === 0 ? (
        <Card title="Nothing to compare yet">
          <EmptyState title="No assignment ran in more than one term">
            Assignments are matched by their short name (slug) across terms of the same course code.
          </EmptyState>
        </Card>
      ) : (
        assignments.map((a) => (
          <Card key={a.slug} title={a.title} description={`Median grade by term (0–100), with the details beside it`}>
            <ChartTips>
              <ul className="space-y-3" aria-label={`Median grade by term for ${a.title}`}>
                {a.terms.map((t) => (
                  <li
                    key={t.courseId}
                    className="grid gap-2 text-sm sm:grid-cols-[10rem_1fr_minmax(0,20rem)] sm:items-center"
                  >
                    <span className="flex flex-wrap items-center gap-2 font-medium">
                      {t.term}
                      {t.courseId === courseId && <Badge tone="neutral">this term</Badge>}
                    </span>
                    {t.suppressed ? (
                      <span className="text-muted">{t.submissions} students: too few to show</span>
                    ) : t.medianGrade === null ? (
                      <span className="text-muted">no grades yet</span>
                    ) : (
                      <span
                        className="flex items-center gap-2"
                        data-tip={`${t.term}: median grade ${one(t.medianGrade)}`}
                      >
                        <span className="h-3 flex-1">
                          <span
                            className="block h-3 rounded-r-[4px]"
                            style={{ width: `${t.medianGrade ?? 0}%`, background: "var(--viz-1)" }}
                          />
                        </span>
                        <span className="w-10 shrink-0 text-right tabular-nums">{one(t.medianGrade)}</span>
                      </span>
                    )}
                    {!t.suppressed && (
                      <span className="text-muted">
                        {t.submissions} students · tests {one(t.medianTestScore)} · on time {rate(t.onTimeRate)} ·
                        missing {rate(t.missingRate)}
                        {t.mostFailed[0] && (
                          <>
                            <br />
                            Most failed: {t.mostFailed.map((f) => `${f.title} (${percent(f.rate)})`).join(", ")}
                          </>
                        )}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </ChartTips>
            <TableView
              caption={`${a.title} by term`}
              head={["Term", "Students", "Median grade", "Mean grade", "Median test score", "On time", "Missing"]}
              rows={a.terms.map((t) =>
                t.suppressed
                  ? [t.term, t.submissions, "–", "–", "–", "–", "–"]
                  : [
                      t.term,
                      t.submissions,
                      one(t.medianGrade),
                      one(t.meanGrade),
                      one(t.medianTestScore),
                      rate(t.onTimeRate),
                      rate(t.missingRate),
                    ],
              )}
            />
          </Card>
        ))
      )}
    </div>
  );
}
