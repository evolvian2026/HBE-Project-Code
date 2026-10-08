import { formatInZone } from "@hbe/core";
import Link from "next/link";
import type { FailedCategory, PerformanceRow } from "@/lib/performance";
import { fmt } from "./grade";
import { Badge, Card, EmptyState } from "./ui";

/** Every assignment of one student, newest first: status, tests, grade and every report version. */
export function PerformanceTable({ slug, rows, staff }: { slug: string; rows: PerformanceRow[]; staff: boolean }) {
  if (rows.length === 0) return <EmptyState title="No assignments yet" />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" data-testid="performance">
        <thead>
          <tr className="border-b border-border text-left text-muted">
            <th className="py-2 pr-3 font-medium">Assignment</th>
            <th className="px-3 py-2 font-medium">Due</th>
            <th className="px-3 py-2 font-medium">Submission</th>
            <th className="px-3 py-2 text-right font-medium">Tests</th>
            <th className="px-3 py-2 text-right font-medium">Grade</th>
            <th className="py-2 pl-3 font-medium">Reports</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r) => {
            const href = `/i/${slug}/courses/${r.course.id}/assignments/${r.assignment.id}${
              staff ? `/submissions/${r.submission_id}` : ""
            }`;
            const tests =
              r.latest_run_summary?.total !== undefined
                ? `${r.latest_run_summary.passed}/${r.latest_run_summary.total}`
                : "–";
            return (
              <tr key={r.submission_id}>
                <td className="py-2 pr-3">
                  <Link href={href} className="font-medium hover:text-accent">
                    {r.assignment.title}
                  </Link>
                  <span className="block text-xs text-muted">
                    {r.course.code} · {r.course.term}
                    {r.course.archived_at && " · archived"}
                  </span>
                </td>
                <td className="px-3 py-2 text-muted">{formatInZone(r.assignment.due_at, r.course.timezone)}</td>
                <td className="px-3 py-2">
                  {r.status === "missing" ? (
                    <Badge tone="danger">nothing submitted</Badge>
                  ) : r.finalized_at ? (
                    <span>
                      {r.final_sha?.slice(0, 7)}
                      {r.late_days ? <span className="text-warning"> · {r.late_days}d late</span> : null}
                    </span>
                  ) : (
                    <Badge>open</Badge>
                  )}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-muted">{tests}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {r.final_score !== null ? (
                    <span className="font-medium">
                      {fmt(r.final_score)}
                      {staff && !r.grade_released_at_version && <span className="text-muted"> (not released)</span>}
                    </span>
                  ) : (
                    "–"
                  )}
                </td>
                <td className="py-2 pl-3">
                  {r.reports.length === 0 ? (
                    <span className="text-muted">–</span>
                  ) : (
                    <span className="flex flex-wrap gap-x-2">
                      {r.reports.map((rep) => (
                        <a
                          key={rep.id}
                          href={`/i/${slug}/reports/${rep.id}/pdf`}
                          className="text-accent hover:underline"
                          title={`Generated ${formatInZone(rep.generated_at, r.course.timezone)}`}
                        >
                          v{rep.version}
                        </a>
                      ))}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Headline numbers and the test categories failed most often. */
export function PerformanceSummary({ rows, failed }: { rows: PerformanceRow[]; failed: FailedCategory[] }) {
  const graded = rows.filter((r) => r.final_score !== null);
  const average = graded.length ? graded.reduce((s, r) => s + Number(r.final_score), 0) / graded.length : null;
  const late = rows.filter((r) => (r.late_days ?? 0) > 0).length;
  const missing = rows.filter((r) => r.status === "missing").length;
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <Card title="Average grade">
        <p className="text-3xl font-semibold tabular-nums">{average === null ? "–" : fmt(average)}</p>
        <p className="mt-1 text-sm text-muted">over {graded.length} graded assignment(s)</p>
      </Card>
      <Card title="Submissions">
        <p className="text-sm">
          {rows.filter((r) => r.finalized_at).length} finished · {late} late · {missing} missing
        </p>
      </Card>
      <Card title="Tests failed most" description="By category, on the latest runs">
        {failed.length === 0 ? (
          <p className="text-sm text-muted">No failing tests.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {failed.map((f) => (
              <li key={f.category} className="flex justify-between">
                <span>{f.category}</span>
                <span className="tabular-nums text-muted">{f.failures}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
