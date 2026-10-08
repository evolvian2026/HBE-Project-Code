import { Badge } from "./ui";

export interface GradeRow {
  id: string;
  version: number;
  final_score: string;
  computed_score: string;
  override_score: string | null;
  late_days: number;
  late_penalty: string;
  complete: boolean;
  released_at: string | null;
  created_at: string;
  components: {
    automated: { weight: number; score: number | null; points: number };
    rubric: { weight: number; score: number | null; points: number; points_awarded: number; max_points: number };
    process: { weight: number; score: number | null; points: number };
    pending: string[];
    raw: number;
  };
}

export const GRADE_COLUMNS =
  "id, version, final_score, computed_score, override_score, late_days, late_penalty, complete, released_at, created_at, components";

export const fmt = (n: number | string | null | undefined) =>
  n === null || n === undefined ? "–" : Number(n).toLocaleString("en", { maximumFractionDigits: 2 });

/** The final grade and how it was made up. `staff` adds what is still missing. */
export function GradeBreakdown({ grade, staff = false }: { grade: GradeRow; staff?: boolean }) {
  const c = grade.components;
  const rows = [
    {
      label: "Automated tests",
      detail: c.automated.score === null ? "no graded run yet" : `${fmt(c.automated.score)} / 100`,
      ...c.automated,
    },
    {
      label: "Rubric",
      detail: c.rubric.max_points
        ? `${fmt(c.rubric.points_awarded)} / ${fmt(c.rubric.max_points)} points`
        : "no rubric",
      ...c.rubric,
    },
    { label: "Process (activity)", detail: `${fmt(c.process.score ?? 0)} / 100`, ...c.process },
  ].filter((r) => r.weight > 0);
  const overridden = grade.override_score !== null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <p className="text-3xl font-semibold tabular-nums" data-testid="final-grade">
          {fmt(grade.final_score)}
          <span className="text-base font-normal text-muted"> / 100</span>
        </p>
        {staff && (
          <span className="flex items-center gap-2">
            {!grade.complete && <Badge tone="warning">incomplete</Badge>}
            {grade.released_at ? <Badge tone="success">released</Badge> : <Badge>not released</Badge>}
          </span>
        )}
      </div>
      <table className="w-full text-sm">
        <tbody className="divide-y divide-border">
          {rows.map((r) => (
            <tr key={r.label}>
              <td className="py-1.5">{r.label}</td>
              <td className="py-1.5 text-muted">{r.detail}</td>
              <td className="py-1.5 text-right text-muted tabular-nums">× {r.weight}%</td>
              <td className="py-1.5 text-right tabular-nums">{fmt(r.points)}</td>
            </tr>
          ))}
          {grade.late_days > 0 && (
            <tr>
              <td className="py-1.5">Late penalty</td>
              <td className="py-1.5 text-muted" colSpan={2}>
                {grade.late_days} day{grade.late_days === 1 ? "" : "s"} late: −{fmt(grade.late_penalty)}%
              </td>
              <td className="py-1.5 text-right tabular-nums">{fmt(grade.computed_score)}</td>
            </tr>
          )}
          {overridden && (
            <tr>
              <td className="py-1.5" colSpan={3}>
                Adjusted by {staff ? "an instructor" : "your instructor"} (calculated {fmt(grade.computed_score)})
              </td>
              <td className="py-1.5 text-right font-medium tabular-nums">{fmt(grade.final_score)}</td>
            </tr>
          )}
        </tbody>
      </table>
      {staff && c.pending.length > 0 && <p className="text-sm text-warning">Still needed: {c.pending.join(", ")}.</p>}
    </div>
  );
}
