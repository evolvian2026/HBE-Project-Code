import { DEFAULT_STAGE_SETTINGS, institutionSettings, utcToZonedLocal } from "@hbe/core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Card } from "@/components/ui";
import { requireCourse } from "@/lib/course";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { loadProfiles, loadSuites } from "../data";
import { AssignmentForm } from "../form";

export const metadata: Metadata = { title: "New assignment" };

export default async function NewAssignmentPage({ params }: { params: Promise<{ slug: string; courseId: string }> }) {
  const { slug, courseId } = await params;
  const { course, canManage, ctx } = await requireCourse(slug, courseId);
  if (!canManage) notFound();
  const supabase = await createSupabaseServerClient();
  const [profiles, suites, { data: inst }] = await Promise.all([
    loadProfiles(ctx.institution.id),
    loadSuites(ctx.institution.id),
    supabase.from("institutions").select("settings").eq("id", ctx.institution.id).single(),
  ]);
  // What the institution's admins chose new assignments start with (Settings).
  const d = institutionSettings(inst?.settings).assignment_defaults;
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
          mode: "individual",
          graderSuiteId: "",
          triggers: d.triggers,
          templateRepo: "",
          dueAt: utcToZonedLocal(twoWeeks, course.timezone),
          releaseAt: "",
          runQuota: d.run_quota_per_day,
          weights: d.weights,
          late: d.late_policy,
          regradeWindowDays: d.regrade_window_days,
          postFeedbackToGithub: d.post_feedback_to_github,
          stages: DEFAULT_STAGE_SETTINGS,
          spec: "",
          published: false,
        }}
      />
    </Card>
  );
}
