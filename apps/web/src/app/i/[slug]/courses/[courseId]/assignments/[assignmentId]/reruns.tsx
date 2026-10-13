import { formatInZone } from "@hbe/core";
import { LiveRuns } from "@/components/live-runs";
import { inFilter, realtimeAuth } from "@/lib/realtime";
import { Badge, Card } from "@/components/ui";
import type { createSupabaseServerClient } from "@/lib/supabase/server";
import { RerunForm } from "./forms";

type Supabase = Awaited<ReturnType<typeof createSupabaseServerClient>>;

interface Batch {
  id: string;
  scope: "all" | "unfinished";
  runs: number;
  skipped: number;
  created_at: string;
  suite: { title: string; version: number } | null;
  requester: { full_name: string | null; email: string | null } | null;
}

const ACTIVE = new Set(["queued", "dispatched", "running"]);

/** Instructors: re-run the tests of every submission, and the progress of recent re-runs. */
export async function RerunCard({
  supabase,
  ids,
  institutionId,
  suite,
  timezone,
}: {
  supabase: Supabase;
  ids: { slug: string; courseId: string; assignmentId: string };
  institutionId: string;
  suite: { id: string; key: string };
  timezone: string;
}) {
  const [{ data: versions }, { data: batchRows }] = await Promise.all([
    supabase
      .from("grader_suites")
      .select("id, title, version")
      .eq("key", suite.key)
      .eq("status", "active")
      .or(`institution_id.is.null,institution_id.eq.${institutionId}`)
      .order("version", { ascending: false }),
    supabase
      .from("run_batches")
      .select(
        "id, scope, runs, skipped, created_at, suite:grader_suites(title, version), requester:profiles(full_name, email)",
      )
      .eq("assignment_id", ids.assignmentId)
      .order("created_at", { ascending: false })
      .limit(3),
  ]);
  const batches = (batchRows ?? []) as unknown as Batch[];
  const { data: runRows } = batches.length
    ? await supabase
        .from("evaluation_runs")
        .select("batch_id, status")
        .in(
          "batch_id",
          batches.map((b) => b.id),
        )
    : { data: [] };
  const progress = new Map<string, { done: number; active: number; problems: number }>();
  for (const r of (runRows ?? []) as { batch_id: string; status: string }[]) {
    const p = progress.get(r.batch_id) ?? { done: 0, active: 0, problems: 0 };
    if (ACTIVE.has(r.status)) p.active++;
    else if (r.status === "completed") p.done++;
    else p.problems++;
    progress.set(r.batch_id, p);
  }
  const anyActive = [...progress.values()].some((p) => p.active > 0);
  const realtime = anyActive ? await realtimeAuth(supabase) : null;

  return (
    <Card
      title="Re-run tests"
      description="Test every submission again: at the graded commit once the cutoff has passed (this updates the grade), otherwise at the latest push. A team is tested once. Doesn't use students' daily runs."
    >
      {anyActive && (
        <LiveRuns
          realtime={realtime}
          filter={inFilter(
            "batch_id",
            batches.map((b) => b.id),
          )}
          active
        />
      )}
      <div className="grid gap-6 lg:grid-cols-2">
        <RerunForm
          {...ids}
          currentSuiteId={suite.id}
          suites={((versions ?? []) as { id: string; title: string; version: number }[]).map((v) => ({
            id: v.id,
            label: `${v.title} · v${v.version}`,
          }))}
        />
        {batches.length > 0 && (
          <ul className="divide-y divide-border text-sm" data-testid="rerun-batches">
            {batches.map((b) => {
              const p = progress.get(b.id) ?? { done: 0, active: 0, problems: 0 };
              return (
                <li key={b.id} className="space-y-1 py-2">
                  <p className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      {b.runs} run{b.runs === 1 ? "" : "s"} · {b.suite ? `${b.suite.title} v${b.suite.version}` : ""}
                      {b.scope === "unfinished" && " · untested only"}
                    </span>
                    {p.active > 0 ? (
                      <Badge tone="accent">
                        {p.done + p.problems} of {b.runs} finished
                      </Badge>
                    ) : (
                      <Badge tone={p.problems ? "warning" : "success"}>
                        done{p.problems ? ` · ${p.problems} didn't finish` : ""}
                      </Badge>
                    )}
                  </p>
                  <p className="text-xs text-muted">
                    {formatInZone(b.created_at, timezone)} by{" "}
                    {b.requester?.full_name ?? b.requester?.email ?? "someone"}
                    {b.skipped > 0 && ` · ${b.skipped} skipped`}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );
}
