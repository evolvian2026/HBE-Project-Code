import { notFound } from "next/navigation";
import { requireCourse } from "@/lib/course";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { AssignmentFormValues } from "./form";

export interface AssignmentRow {
  id: string;
  slug: string;
  title: string;
  spec_md: string;
  status: "draft" | "published" | "closed";
  mode: "individual" | "team";
  template_repo: string | null;
  due_at: string;
  release_at: string | null;
  run_quota_per_day: number;
  weights: AssignmentFormValues["weights"];
  late_policy: AssignmentFormValues["late"];
  regrade_window_days: number;
  stage_settings: unknown;
  published_at: string | null;
  triggers: { on_push: boolean; on_pull_request: boolean; manual: boolean };
  profile: { id: string; display_name: string; key: string; version: number } | null;
  suite: { id: string; title: string; key: string; version: number } | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function loadAssignment(slug: string, courseId: string, assignmentId: string) {
  const course = await requireCourse(slug, courseId);
  if (!UUID.test(assignmentId)) notFound();
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("assignments")
    .select(
      "id, slug, title, spec_md, status, mode, template_repo, due_at, release_at, run_quota_per_day, weights, late_policy, regrade_window_days, stage_settings, published_at, triggers, profile:stack_profiles(id, display_name, key, version), suite:grader_suites(id, title, key, version)",
    )
    .eq("id", assignmentId)
    .eq("course_id", courseId)
    .maybeSingle();
  if (!data) notFound();
  return { ...course, supabase, assignment: data as unknown as AssignmentRow };
}

export async function loadProfiles(institutionId: string) {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("stack_profiles")
    .select("id, display_name, description, version, institution_id")
    .eq("status", "active")
    .or(`institution_id.is.null,institution_id.eq.${institutionId}`)
    .order("display_name");
  return (data ?? []).map((p) => ({
    id: p.id,
    label: `${p.display_name} · v${p.version}${p.institution_id ? "" : " (global)"}`,
    description: p.description,
  }));
}

/** Active hidden test suites this institution may use (global ones and its own). */
export async function loadSuites(institutionId: string) {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("grader_suites")
    .select("id, title, key, version, institution_id, profile:stack_profiles(display_name)")
    .eq("status", "active")
    .or(`institution_id.is.null,institution_id.eq.${institutionId}`)
    .order("title");
  return (
    (data ?? []) as unknown as {
      id: string;
      title: string;
      version: number;
      institution_id: string | null;
      profile: { display_name: string } | null;
    }[]
  ).map((s) => ({
    id: s.id,
    label: `${s.title} · v${s.version}${s.profile ? ` · for ${s.profile.display_name}` : ""}${s.institution_id ? "" : " (global)"}`,
  }));
}
