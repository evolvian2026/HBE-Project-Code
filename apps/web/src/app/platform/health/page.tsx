import { formatInZone, timeAgo } from "@hbe/core";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell, PageTitle } from "@/components/app-shell";
import { AutoRefresh } from "@/components/auto-refresh";
import { Alert, Badge, Card, EmptyState } from "@/components/ui";
import { apiFetch } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { enforceAdminMfa } from "@/lib/mfa";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = { title: "System health" };

const TZ = "Asia/Singapore";

interface Health {
  queues: { name: string; queued: number; active: number; retrying: number; failed: number }[];
  recentFailures: { name: string; at: string; error: string | null }[];
  webhooks: { unprocessed: number; oldestUnprocessedAt: string | null; errored: number };
  runs: { queued: number; active: number; concurrency: number };
  runnerMinutes: { used: number; budget: number };
  storageBytes: { artifacts: number; snapshots: number; exports: number };
  institutions: {
    id: string;
    name: string;
    slug: string;
    status: string;
    students: number;
    minutes: number;
    runs: number;
  }[];
}

/** Queues, failed jobs, webhook lag, test runs and usage across institutions (super admins). */
export default async function HealthPage() {
  const session = await requireSession();
  if (!session.isSuperAdmin) notFound();
  await enforceAdminMfa("/platform/health");
  const result = await apiFetch<Health>("/v1/platform/health");
  const h = result.ok ? result.data : null;
  // A webhook waiting more than 5 minutes means the worker is behind (or down).
  const lagging = h?.webhooks.oldestUnprocessedAt
    ? Date.now() - Date.parse(h.webhooks.oldestUnprocessedAt) > 5 * 60_000
    : false;

  return (
    <AppShell session={session}>
      <AutoRefresh active intervalMs={15_000} />
      <PageTitle
        title="System health"
        subtitle={
          <>
            Refreshes every 15 seconds.{" "}
            <Link href="/platform" className="link">
              Back to the console
            </Link>
          </>
        }
      />
      {!h ? (
        <Alert tone="error">Could not load health: {result.ok ? "" : result.message}</Alert>
      ) : (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-4" data-testid="health-summary">
            <Card title="Test runs">
              <p className="text-2xl font-semibold tabular-nums">{h.runs.active}</p>
              <p className="text-sm text-muted">
                running of {h.runs.concurrency} at once · {h.runs.queued} waiting
              </p>
            </Card>
            <Card title="Runner minutes">
              <p className="text-2xl font-semibold tabular-nums">{h.runnerMinutes.used}</p>
              <p className="text-sm text-muted">of {h.runnerMinutes.budget} this month</p>
            </Card>
            <Card title="Webhooks waiting">
              <p className="text-2xl font-semibold tabular-nums">{h.webhooks.unprocessed}</p>
              <p className="text-sm text-muted">
                {h.webhooks.oldestUnprocessedAt ? `oldest ${timeAgo(h.webhooks.oldestUnprocessedAt)}` : "none"}
                {h.webhooks.errored > 0 && ` · ${h.webhooks.errored} failing`}
              </p>
              {lagging && <Badge tone="warning">behind</Badge>}
            </Card>
            <Card title="Stored">
              <p className="text-2xl font-semibold tabular-nums">
                {formatBytes(h.storageBytes.artifacts + h.storageBytes.snapshots + h.storageBytes.exports)}
              </p>
              <p className="text-sm text-muted">run files, source snapshots, exports</p>
            </Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card title="Queues" description="Jobs waiting, running and retrying; failures in the last 24 hours.">
              {h.queues.length === 0 ? (
                <EmptyState title="Nothing queued" />
              ) : (
                <table className="w-full text-sm" data-testid="queues">
                  <thead className="text-left text-muted">
                    <tr>
                      <th className="pb-2 font-medium">Queue</th>
                      <th className="pb-2 text-right font-medium">Waiting</th>
                      <th className="pb-2 text-right font-medium">Running</th>
                      <th className="pb-2 text-right font-medium">Retrying</th>
                      <th className="pb-2 text-right font-medium">Failed</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border tabular-nums">
                    {h.queues.map((q) => (
                      <tr key={q.name}>
                        <td className="py-1.5 font-mono text-xs">{q.name}</td>
                        <td className="py-1.5 text-right">{q.queued}</td>
                        <td className="py-1.5 text-right">{q.active}</td>
                        <td className="py-1.5 text-right">{q.retrying}</td>
                        <td className={`py-1.5 text-right ${q.failed ? "text-danger" : ""}`}>{q.failed}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
            <Card title="Recent failures" description="Jobs that gave up after their retries (last 24 hours).">
              {h.recentFailures.length === 0 ? (
                <EmptyState title="No failures" />
              ) : (
                <ul className="divide-y divide-border text-sm">
                  {h.recentFailures.map((f, i) => (
                    <li key={i} className="py-2">
                      <span className="font-mono text-xs">{f.name}</span>{" "}
                      <span className="text-muted">{formatInZone(f.at, TZ)}</span>
                      {f.error && <p className="mt-0.5 break-all text-xs text-danger">{f.error}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <Card title="Institutions this month">
            <table className="w-full text-sm" data-testid="institution-usage">
              <thead className="text-left text-muted">
                <tr>
                  <th className="pb-2 font-medium">Institution</th>
                  <th className="pb-2 text-right font-medium">Active students</th>
                  <th className="pb-2 text-right font-medium">Test runs</th>
                  <th className="pb-2 text-right font-medium">Runner minutes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border tabular-nums">
                {h.institutions.map((i) => (
                  <tr key={i.id}>
                    <td className="py-1.5">
                      {i.name} {i.status !== "active" && <Badge tone="warning">{i.status.replace("_", " ")}</Badge>}
                    </td>
                    <td className="py-1.5 text-right">{i.students}</td>
                    <td className="py-1.5 text-right">{i.runs}</td>
                    <td className="py-1.5 text-right">{i.minutes}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      )}
    </AppShell>
  );
}
