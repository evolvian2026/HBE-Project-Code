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
  template_repo: string | null;
  due_at: string;
  release_at: string | null;
  run_quota_per_day: number;
  weights: AssignmentFormValues["weights"];
  late_policy: AssignmentFormValues["late"];
  published_at: string | null;
  profile: { id: string; display_name: string; key: string; version: number } | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function loadAssignment(slug: string, courseId: string, assignmentId: string) {
  const course = await requireCourse(slug, courseId);
  if (!UUID.test(assignmentId)) notFound();
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("assignments")
    .select(
      "id, slug, title, spec_md, status, template_repo, due_at, release_at, run_quota_per_day, weights, late_policy, published_at, profile:stack_profiles(id, display_name, key, version)",
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
