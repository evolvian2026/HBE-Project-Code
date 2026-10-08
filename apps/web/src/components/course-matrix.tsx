import Link from "next/link";
import { fmt } from "./grade";
import { Badge } from "./ui";

/** A row of the submission_overview view. */
export interface OverviewRow {
  submission_id: string;
  assignment_id: string;
  user_id: string;
  status: string;
  repository_id: string | null;
  late_days: number | null;
  finalized_at: string | null;
  last_activity_at: string | null;
  latest_run_score: string | null;
  latest_run_summary: { passed?: number; total?: number; blockedBy?: string | null } | null;
  final_score: string | null;
  grade_complete: boolean | null;
  grade_released_at_version: string | null;
  created_at: string;
}

export const OVERVIEW_COLUMNS =
  "submission_id, assignment_id, user_id, status, repository_id, late_days, finalized_at, last_activity_at, latest_run_score, latest_run_summary, final_score, grade_complete, grade_released_at_version, created_at";

export interface MatrixCell {
  row: OverviewRow | undefined;
  href: string | null;
  risks: string[];
}

function CellContent({ row, risks }: Omit<MatrixCell, "href">) {
  if (!row) return <span className="text-muted">–</span>;
  if (row.final_score !== null) {
    return (
      <span className="tabular-nums" title={row.grade_released_at_version ? "Released" : "Not released yet"}>
        <span className="font-medium">{fmt(row.final_score)}</span>
        {!row.grade_complete && <span className="text-warning"> *</span>}
        {row.grade_released_at_version && <span className="text-success"> ✓</span>}
      </span>
    );
  }
  if (row.status === "missing") return <Badge tone="danger">missing</Badge>;
  const tests =
    row.latest_run_summary?.total !== undefined
      ? `${row.latest_run_summary.passed}/${row.latest_run_summary.total}`
      : row.latest_run_score !== null
        ? fmt(row.latest_run_score)
        : null;
  return (
    <span className="flex items-center justify-center gap-1 text-muted">
      {row.finalized_at ? "submitted" : (tests ?? "–")}
      {risks.length > 0 && (
        <span className="text-warning" title={risks.join("; ")} aria-label={`At risk: ${risks.join("; ")}`}>
          ⚠
        </span>
      )}
    </span>
  );
}

/** Students × assignments: grade when there is one, otherwise latest tests and risk flags. */
export function CourseMatrix({
  students,
  assignments,
  cell,
}: {
  students: { userId: string; name: string }[];
  assignments: { id: string; title: string }[];
  cell: (userId: string, assignmentId: string) => MatrixCell;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" data-testid="course-matrix">
        <thead>
          <tr className="border-b border-border text-left text-muted">
            <th className="py-2 pr-4 font-medium">Student</th>
            {assignments.map((a) => (
              <th key={a.id} className="px-3 py-2 text-center font-medium">
                {a.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {students.map((s) => (
            <tr key={s.userId}>
              <td className="py-2 pr-4">{s.name}</td>
              {assignments.map((a) => {
                const c = cell(s.userId, a.id);
                return (
                  <td key={a.id} className="px-3 py-2 text-center">
                    {c.href ? (
                      <Link href={c.href} className="hover:underline">
                        <CellContent row={c.row} risks={c.risks} />
                      </Link>
                    ) : (
                      <CellContent row={c.row} risks={c.risks} />
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 text-xs text-muted">
        Numbers are grades (✓ released, * incomplete); before grading, tests passed on the latest run. ⚠ marks students
        who may need a nudge.
      </p>
    </div>
  );
}
