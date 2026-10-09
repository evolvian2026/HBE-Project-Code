import { formatInZone } from "@hbe/core";
import Link from "next/link";
import { Badge } from "./ui";

export type RunStatus = "queued" | "dispatched" | "running" | "completed" | "failed" | "infra_error" | "cancelled";

export interface RunSummary {
  id: string;
  sha: string;
  trigger: string;
  status: RunStatus;
  score: string | null;
  summary: { passed?: number; total?: number; blockedBy?: string | null } | null;
  queued_at: string;
}

const STATUS: Record<RunStatus, { label: string; tone: "neutral" | "accent" | "success" | "warning" | "danger" }> = {
  queued: { label: "queued", tone: "neutral" },
  dispatched: { label: "starting", tone: "accent" },
  running: { label: "running", tone: "accent" },
  completed: { label: "finished", tone: "success" },
  failed: { label: "failed", tone: "danger" },
  infra_error: { label: "platform error", tone: "warning" },
  cancelled: { label: "cancelled", tone: "neutral" },
};

const TRIGGER: Record<string, string> = {
  push: "push",
  pull_request: "pull request",
  manual: "requested",
  deadline: "deadline",
  regrade: "re-grade",
};

export const isActive = (status: RunStatus) => status === "queued" || status === "dispatched" || status === "running";

/**
 * Whether a run's page should keep refreshing: it is still running, or it has finished and its
 * score is being worked out (the results arrive first, then the worker scores them).
 */
export const stillUpdating = (run: { status: RunStatus; summary: { total?: number } | null }) =>
  isActive(run.status) || (run.status === "completed" && typeof run.summary?.total !== "number");

export function RunStatusBadge({ status }: { status: RunStatus }) {
  const s = STATUS[status] ?? { label: status, tone: "neutral" as const };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

/** "5/7 passed · 70" for a scored run, or the status otherwise. */
export function runOutcome(run: Pick<RunSummary, "status" | "score" | "summary">): string | null {
  if (run.status !== "completed" || !run.summary) return null;
  if (run.summary.blockedBy) return `stopped at ${run.summary.blockedBy}`;
  if (run.summary.total === undefined) return null;
  return `${run.summary.passed}/${run.summary.total} passed${run.score === null ? "" : ` · ${Math.round(Number(run.score))}`}`;
}

export function RunList({
  runs,
  href,
  timezone,
}: {
  runs: RunSummary[];
  href: (id: string) => string;
  timezone: string;
}) {
  return (
    <ul className="divide-y divide-border">
      {runs.map((r) => (
        <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
          <Link href={href(r.id)} className="min-w-0 hover:text-accent">
            <span className="font-mono">{r.sha.slice(0, 7)}</span>
            <span className="text-muted">
              {" · "}
              {TRIGGER[r.trigger] ?? r.trigger} · {formatInZone(r.queued_at, timezone)}
            </span>
          </Link>
          <span className="flex items-center gap-2">
            {runOutcome(r) && <span className="tabular-nums text-muted">{runOutcome(r)}</span>}
            <RunStatusBadge status={r.status} />
          </span>
        </li>
      ))}
    </ul>
  );
}
