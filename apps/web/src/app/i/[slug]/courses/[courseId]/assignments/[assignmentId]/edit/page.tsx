import { stageSettings, utcToZonedLocal } from "@hbe/core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Card } from "@/components/ui";
import { loadAssignment, loadProfiles, loadSuites } from "../../data";
import { AssignmentForm } from "../../form";

export const metadata: Metadata = { title: "Edit assignment" };

export default async function EditAssignmentPage({
  params,
}: {
  params: Promise<{ slug: string; courseId: string; assignmentId: string }>;
}) {
  const { slug, courseId, assignmentId } = await params;
  const { course, canManage, ctx, assignment: a } = await loadAssignment(slug, courseId, assignmentId);
  if (!canManage || a.status === "closed") notFound();
  const [profiles, suites] = await Promise.all([loadProfiles(ctx.institution.id), loadSuites(ctx.institution.id)]);

  return (
    <Card title={`Edit · ${a.title}`}>
      <AssignmentForm
        slug={slug}
        courseId={course.id}
        timezone={course.timezone}
        profiles={profiles}
        suites={suites}
        values={{
          id: a.id,
          title: a.title,
          slug: a.slug,
          stackProfileId: a.profile?.id ?? "",
          mode: a.mode,
          graderSuiteId: a.suite?.id ?? "",
          triggers: a.triggers,
          templateRepo: a.template_repo ?? "",
          dueAt: utcToZonedLocal(new Date(a.due_at), course.timezone),
          releaseAt: a.release_at ? utcToZonedLocal(new Date(a.release_at), course.timezone) : "",
          runQuota: a.run_quota_per_day,
          weights: a.weights,
          late: a.late_policy,
          regradeWindowDays: a.regrade_window_days,
          stages: stageSettings(a.stage_settings),
          spec: a.spec_md,
          published: a.status !== "draft",
        }}
      />
    </Card>
  );
}
