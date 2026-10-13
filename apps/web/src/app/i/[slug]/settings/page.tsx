import { institutionLimits, institutionSettings } from "@hbe/core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Alert, Card } from "@/components/ui";
import { requireMembership } from "@/lib/institution";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { InstitutionSettingsForm } from "./forms";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireMembership(slug);
  if (!ctx.isAdmin) notFound();
  const supabase = await createSupabaseServerClient();
  const [{ data: inst }, { count: students }, { count: invited }] = await Promise.all([
    supabase.from("institutions").select("name, settings, limits").eq("id", ctx.institution.id).single(),
    supabase
      .from("institution_memberships")
      .select("id", { count: "exact", head: true })
      .eq("institution_id", ctx.institution.id)
      .eq("role", "student")
      .eq("status", "active"),
    supabase
      .from("invitations")
      .select("id", { count: "exact", head: true })
      .eq("institution_id", ctx.institution.id)
      .eq("role", "student")
      .is("accepted_at", null)
      .gt("expires_at", new Date().toISOString()),
  ]);
  const settings = institutionSettings(inst?.settings);
  const limits = institutionLimits(inst?.limits);

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
      <Card title="Limits" description="Set by the platform operator. Ask them to change these.">
        <dl className="grid gap-3 text-sm sm:grid-cols-3" data-testid="limits">
          <div>
            <dt className="text-muted">Students</dt>
            <dd className="tabular-nums">
              {students ?? 0} active{invited ? ` + ${invited} invited` : ""}
              {limits.max_active_students ? ` of ${limits.max_active_students}` : " (no limit)"}
            </dd>
          </div>
          <div>
            <dt className="text-muted">Test runs at once</dt>
            <dd className="tabular-nums">{limits.institution_concurrency ?? "the plan's limit"}</dd>
          </div>
          <div>
            <dt className="text-muted">Runner minutes per month</dt>
            <dd className="tabular-nums">{limits.monthly_runner_minutes ?? "the plan's budget"}</dd>
          </div>
        </dl>
      </Card>
    </div>
  );
}
