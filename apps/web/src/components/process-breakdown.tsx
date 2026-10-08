import type { ProcessResult } from "@hbe/core";
import { Alert } from "./ui";

/** A process score with every criterion's explanation (the student-facing breakdown). */
export function ProcessBreakdown({ result, weightInGrade }: { result: ProcessResult; weightInGrade: number }) {
  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-3xl font-semibold tabular-nums">
          {Math.round(result.score)}
          <span className="text-base font-normal text-muted"> / 100</span>
        </p>
        <p className="text-sm text-muted">{weightInGrade}% of the final grade</p>
      </div>
      <ul className="space-y-3">
        {result.criteria.map((c) => (
          <li key={c.key}>
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">{c.label}</span>
              <span className="tabular-nums text-muted">
                {c.points.toFixed(1)} /{" "}
                {((c.weight / result.criteria.reduce((s, x) => s + x.weight, 0)) * 100).toFixed(0)}
              </span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden>
              <div className="h-full rounded-full bg-accent" style={{ width: `${Math.round(c.earned * 100)}%` }} />
            </div>
            <p className="mt-1 text-sm text-muted">{c.explanation}</p>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted">
        {result.meaningfulCommits} meaningful commit{result.meaningfulCommits === 1 ? "" : "s"}
        {result.creditedCommits < result.meaningfulCommits &&
          ` (${result.creditedCommits} counted: at most a few per day count)`}
        {result.pendingCommits > 0 && ` · ${result.pendingCommits} still being analysed`}
      </p>
      {result.unattributedCommits > 0 && (
        <Alert tone="info">
          {result.unattributedCommits} commit{result.unattributedCommits === 1 ? " isn't" : "s aren't"} linked to your
          GitHub account, so {result.unattributedCommits === 1 ? "it doesn't" : "they don't"} count. Make sure{" "}
          <code>git config user.email</code> is an email address verified on your GitHub account.
        </Alert>
      )}
    </div>
  );
}
