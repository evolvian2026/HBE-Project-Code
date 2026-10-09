import { formatInZone } from "@hbe/core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AutoRefresh } from "@/components/auto-refresh";
import { Alert, Badge, Button, Card, EmptyState } from "@/components/ui";
import { requireMembership } from "@/lib/institution";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { endContract, startExport } from "./actions";

export const metadata: Metadata = { title: "Records" };

const STATUS_TONE = { queued: "neutral", running: "accent", ready: "success", failed: "danger" } as const;
const size = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export default async function RecordsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const ctx = await requireMembership(slug);
  if (!ctx.isAdmin) notFound();
  const supabase = await createSupabaseServerClient();
  const [{ data: inst }, { data: exports }] = await Promise.all([
    supabase
      .from("institutions")
      .select("status, contract_started_at, contract_ended_at, purge_after")
      .eq("id", ctx.institution.id)
      .single(),
    supabase
      .from("record_exports")
      .select("id, status, size, files, error, created_at, finished_at")
      .eq("institution_id", ctx.institution.id)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);
  const list = (exports ?? []) as {
    id: string;
    status: keyof typeof STATUS_TONE;
    size: number | null;
    files: number | null;
    error: string | null;
    created_at: string;
  }[];
  const busy = list.some((e) => e.status === "queued" || e.status === "running");
  const tz = "Asia/Singapore";
  const day = (iso: string) =>
    new Date(iso).toLocaleDateString("en-SG", { day: "numeric", month: "long", year: "numeric", timeZone: tz });

  return (
    <div className="max-w-3xl space-y-6">
      {query.error && <Alert tone="error">{query.error}</Alert>}
      {query.ended && <Alert tone="success">The contract has ended. The institution is now read-only.</Alert>}

      <Card title="Contract and retention">
        {inst?.contract_ended_at ? (
          <div className="space-y-2 text-sm" data-testid="contract-ended">
            <p>
              The contract ended on <strong>{day(inst.contract_ended_at)}</strong>. The institution is read-only: people
              can sign in and see their records, but nothing changes.
            </p>
            {inst.purge_after && (
              <Alert tone="info">
                All records (grades, grade reports, source snapshots, test runs and their files) will be permanently
                deleted on <strong>{day(inst.purge_after)}</strong>. Download a full export before then. Admins are
                reminded 90 and 30 days ahead.
              </Alert>
            )}
          </div>
        ) : (
          <div className="space-y-4 text-sm">
            <p>
              Records are kept while the contract runs and for two years after it ends, then permanently deleted. Files
              are also copied every night to a separate backup bucket.
            </p>
            <details className="rounded-md border border-border p-3">
              <summary className="cursor-pointer font-medium">End the contract</summary>
              <form action={endContract} className="mt-3 space-y-3">
                <input type="hidden" name="slug" value={slug} />
                <p className="text-muted">
                  The institution becomes read-only today, and its records are deleted two years later. Only the
                  platform team can undo this.
                </p>
                <label className="flex items-center gap-2">
                  <input type="checkbox" name="confirm" /> I understand: end {ctx.institution.name}&apos;s contract
                </label>
                <Button type="submit" variant="danger">
                  End the contract
                </Button>
              </form>
            </details>
          </div>
        )}
      </Card>

      <Card
        title="Full export"
        description="A ZIP of every grade report (PDF and JSON), every source snapshot, and a CSV of all grades."
        actions={
          <form action={startExport}>
            <input type="hidden" name="slug" value={slug} />
            <Button type="submit" disabled={busy || inst?.status === "purged"}>
              {busy ? "Preparing…" : "Export all records"}
            </Button>
          </form>
        }
      >
        <AutoRefresh active={busy} />
        {list.length === 0 ? (
          <EmptyState title="No exports yet" />
        ) : (
          <ul className="divide-y divide-border text-sm" data-testid="exports">
            {list.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <span>
                  {formatInZone(e.created_at, tz)}
                  {e.status === "ready" && e.size !== null && (
                    <span className="text-muted">
                      {" "}
                      · {e.files} files · {size(Number(e.size))}
                    </span>
                  )}
                  {e.error && <span className="block text-xs text-danger">{e.error}</span>}
                </span>
                <span className="flex items-center gap-3">
                  {e.status === "ready" && (
                    <a href={`/i/${slug}/records/exports/${e.id}`} className="text-accent hover:underline">
                      Download
                    </a>
                  )}
                  <Badge tone={STATUS_TONE[e.status]}>{e.status}</Badge>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
