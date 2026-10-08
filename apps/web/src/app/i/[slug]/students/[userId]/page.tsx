import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { PerformanceSummary, PerformanceTable } from "@/components/performance";
import { Badge, Card, roleTone } from "@/components/ui";
import { requireMembership } from "@/lib/institution";
import { loadPerformance } from "@/lib/performance";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Student" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A student's performance history for teachers and admins (FR-9.3): every course, term and
 * assignment they can see, including archived courses, with grades and report versions.
 */
export default async function StudentProfilePage({ params }: { params: Promise<{ slug: string; userId: string }> }) {
  const { slug, userId } = await params;
  const { session, institution, isStaff } = await requireMembership(slug);
  if (userId === session.userId) redirect(`/i/${slug}/grades`);
  if (!isStaff || !UUID.test(userId)) notFound();

  const supabase = await createSupabaseServerClient();
  const [{ data: member }, { data: profile }, performance] = await Promise.all([
    supabase
      .from("institution_memberships")
      .select("role, status, external_id")
      .eq("institution_id", institution.id)
      .eq("user_id", userId)
      .maybeSingle(),
    supabase.from("profiles").select("full_name, email, github_login").eq("id", userId).maybeSingle(),
    loadPerformance(supabase, institution.id, userId),
  ]);
  if (!member || !profile) notFound();

  return (
    <div className="space-y-6">
      <div>
        <h2 className="flex flex-wrap items-center gap-2 text-xl font-semibold">
          {profile.full_name ?? profile.email}
          <Badge tone={roleTone(member.role)}>{member.role}</Badge>
          {member.status !== "active" && <Badge tone="warning">deactivated</Badge>}
        </h2>
        <p className="mt-1 text-sm text-muted">
          {profile.email}
          {profile.github_login && ` · @${profile.github_login}`}
          {member.external_id && ` · ID ${member.external_id}`}
        </p>
      </div>
      <PerformanceSummary rows={performance.rows} failed={performance.failedCategories} />
      <Card title="Assignments" description="Across every course you can see, newest first.">
        <PerformanceTable slug={slug} rows={performance.rows} staff />
      </Card>
    </div>
  );
}
