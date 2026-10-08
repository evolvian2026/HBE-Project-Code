import { utcToZonedLocal } from "@hbe/core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Card } from "@/components/ui";
import { loadAssignment, loadProfiles } from "../../data";
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
  const profiles = await loadProfiles(ctx.institution.id);

  return (
    <Card title={`Edit · ${a.title}`}>
      <AssignmentForm
        slug={slug}
        courseId={course.id}
        timezone={course.timezone}
        profiles={profiles}
        values={{
          id: a.id,
          title: a.title,
          slug: a.slug,
          stackProfileId: a.profile?.id ?? "",
          templateRepo: a.template_repo ?? "",
          dueAt: utcToZonedLocal(new Date(a.due_at), course.timezone),
          releaseAt: a.release_at ? utcToZonedLocal(new Date(a.release_at), course.timezone) : "",
          runQuota: a.run_quota_per_day,
          weights: a.weights,
          late: a.late_policy,
          spec: a.spec_md,
          published: a.status !== "draft",
        }}
      />
    </Card>
  );
}
