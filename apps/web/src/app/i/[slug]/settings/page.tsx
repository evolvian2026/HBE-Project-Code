import { institutionSettings } from "@hbe/core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Alert, Card } from "@/components/ui";
import { apiFetch } from "@/lib/api";
import { formatBytes } from "@/lib/format";
import { requireMembership } from "@/lib/institution";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { InstitutionSettingsForm } from "./forms";

export const metadata: Metadata = { title: "Settings" };

interface Usage {
  month: string;
  runnerMinutes: { used: number; allowance: number };
  runs: Record<string, number>;
  concurrency: number;
  students: { active: number; invited: number; limit: number | null };
  storageBytes: { artifacts: number; snapshots: number; exports: number };
  gradeReports: number;
  emails: { sent: number; failed: number };
}

const TRIGGER: Record<string, string> = {
  push: "on push",
  pull_request: "on pull requests",
  manual: "asked for",
  deadline: "at deadlines",
  regrade: "re-grades",
};

export default async function SettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireMembership(slug);
  if (!ctx.isAdmin) notFound();
  const supabase = await createSupabaseServerClient();
  const [{ data: inst }, usageResult] = await Promise.all([
    supabase.from("institutions").select("name, settings").eq("id", ctx.institution.id).single(),
    apiFetch<Usage>(`/v1/institutions/${ctx.institution.id}/usage`),
  ]);
  const settings = institutionSettings(inst?.settings);
  const usage = usageResult.ok ? usageResult.data : null;

  return (
    <div className="space-y-6">
      <Card title="Settings" description="Teachers can still change each assignment.">
        {!ctx.writable && (
          <div className="mb-4">
            <Alert tone="info">This institution is read-only; settings can't change.</Alert>
          </div>
        )}
        <InstitutionSettingsForm
          slug={slug}
          name={inst?.name ?? ctx.institution.name}
          defaults={settings.assignment_defaults}
          disabled={!ctx.writable}
        />
      </Card>
      <Card
        title={`Usage this month (${usage?.month ?? ""})`}
        description="Limits are set by the platform operator; ask them to change these."
      >
        {!usage ? (
          <Alert tone="error">Usage couldn't be loaded.</Alert>
        ) : (
          <dl className="grid gap-4 text-sm sm:grid-cols-3" data-testid="limits">
            <div>
              <dt className="text-muted">Students</dt>
              <dd className="tabular-nums">
                {usage.students.active} active{usage.students.invited ? ` + ${usage.students.invited} invited` : ""}
                {usage.students.limit ? ` of ${usage.students.limit}` : " (no limit)"}
              </dd>
            </div>
            <div>
              <dt className="text-muted">Runner minutes</dt>
              <dd className="tabular-nums">
                {usage.runnerMinutes.used} of {usage.runnerMinutes.allowance}
                {usage.runnerMinutes.used >= usage.runnerMinutes.allowance && (
                  <span className="block text-xs text-warning">Automatic test runs are paused until next month.</span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-muted">Test runs at once</dt>
              <dd className="tabular-nums">up to {usage.concurrency}</dd>
            </div>
            <div>
              <dt className="text-muted">Test runs</dt>
              <dd className="tabular-nums">
                {Object.values(usage.runs).reduce((a, b) => a + b, 0)}
                {Object.keys(usage.runs).length > 0 && (
                  <span className="block text-xs text-muted">
                    {Object.entries(usage.runs)
                      .map(([trigger, n]) => `${n} ${TRIGGER[trigger] ?? trigger}`)
                      .join(" · ")}
                  </span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-muted">Stored</dt>
              <dd className="tabular-nums">
                {formatBytes(usage.storageBytes.artifacts + usage.storageBytes.snapshots + usage.storageBytes.exports)}
                <span className="block text-xs text-muted">
                  {formatBytes(usage.storageBytes.snapshots)} graded source ·{" "}
                  {formatBytes(usage.storageBytes.artifacts)} run files · {usage.gradeReports} grade reports
                </span>
              </dd>
            </div>
            <div>
              <dt className="text-muted">Emails sent</dt>
              <dd className="tabular-nums">
                {usage.emails.sent}
                {usage.emails.failed > 0 && (
                  <span className="text-xs text-danger"> · {usage.emails.failed} failed</span>
                )}
              </dd>
            </div>
          </dl>
        )}
      </Card>
    </div>
  );
}
