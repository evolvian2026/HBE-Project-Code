import { formatInZone } from "@hbe/core";
import { Badge, Button } from "@/components/ui";
import { withdrawRegrade } from "../actions";

export interface RegradeRequest {
  id: string;
  message: string;
  status: "open" | "accepted" | "declined" | "withdrawn";
  response: string | null;
  created_at: string;
  resolved_at: string | null;
}

export const REGRADE_COLUMNS = "id, message, status, response, created_at, resolved_at";

const STATUS: Record<RegradeRequest["status"], { label: string; tone: "accent" | "success" | "warning" | "neutral" }> =
  {
    open: { label: "waiting for a reply", tone: "accent" },
    accepted: { label: "accepted", tone: "success" },
    declined: { label: "declined", tone: "warning" },
    withdrawn: { label: "withdrawn", tone: "neutral" },
  };

/** A submission's regrade requests, newest first; the student may withdraw an open one. */
export function RegradeHistory({
  requests,
  timezone,
  withdraw,
}: {
  requests: RegradeRequest[];
  timezone: string;
  withdraw?: { slug: string; courseId: string; assignmentId: string };
}) {
  return (
    <ul className="divide-y divide-border text-sm" data-testid="regrade-requests">
      {requests.map((r) => (
        <li key={r.id} className="space-y-2 py-3">
          <p className="flex flex-wrap items-center gap-2 text-muted">
            <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
            Asked {formatInZone(r.created_at, timezone)}
          </p>
          <p className="whitespace-pre-wrap">{r.message}</p>
          {r.response && (
            <div className="rounded-md border border-border bg-surface-2 p-3">
              <p className="text-xs font-medium text-muted">
                Response{r.resolved_at && ` · ${formatInZone(r.resolved_at, timezone)}`}
              </p>
              <p className="mt-1 whitespace-pre-wrap">{r.response}</p>
            </div>
          )}
          {withdraw && r.status === "open" && (
            <form action={withdrawRegrade}>
              {Object.entries({ ...withdraw, requestId: r.id }).map(([name, value]) => (
                <input key={name} type="hidden" name={name} value={value} />
              ))}
              <Button type="submit" variant="secondary" className="px-2 py-0.5 text-xs">
                Withdraw request
              </Button>
            </form>
          )}
        </li>
      ))}
    </ul>
  );
}
