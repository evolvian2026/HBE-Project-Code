import { DEFAULT_STAGE_SETTINGS, utcToZonedLocal } from "@hbe/core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Card } from "@/components/ui";
import { requireCourse } from "@/lib/course";
import { loadProfiles, loadSuites } from "../data";
import { AssignmentForm } from "../form";

export const metadata: Metadata = { title: "New assignment" };

export default async function NewAssignmentPage({ params }: { params: Promise<{ slug: string; courseId: string }> }) {
  const { slug, courseId } = await params;
  const { course, canManage, ctx } = await requireCourse(slug, courseId);
  if (!canManage) notFound();
  const [profiles, suites] = await Promise.all([loadProfiles(ctx.institution.id), loadSuites(ctx.institution.id)]);
  const twoWeeks = new Date(Date.now() + 14 * 86_400_000);
  twoWeeks.setUTCHours(15, 59, 0, 0); // 23:59 in UTC+8; adjusted to the course zone below

  return (
    <Card
      title={`New assignment · ${course.code}`}
      description="Saved as a draft. Students see nothing until you publish."
    >
      <AssignmentForm
        slug={slug}
        courseId={course.id}
        timezone={course.timezone}
        profiles={profiles}
        suites={suites}
        values={{
          title: "",
          slug: "",
          stackProfileId: profiles[0]?.id ?? "",
          graderSuiteId: "",
          triggers: { on_push: true, on_pull_request: true, manual: true },
          templateRepo: "",
          dueAt: utcToZonedLocal(twoWeeks, course.timezone),
          releaseAt: "",
          runQuota: 5,
          weights: { automated: 60, rubric: 25, process: 15 },
          late: { per_day_percent: 10, max_days: 5, grace_minutes: 15 },
          regradeWindowDays: 7,
          stages: DEFAULT_STAGE_SETTINGS,
          spec: "",
          published: false,
        }}
      />
    </Card>
  );
}
