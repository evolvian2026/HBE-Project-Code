import type { SupabaseClient } from "@supabase/supabase-js";
import { OVERVIEW_COLUMNS, type OverviewRow } from "@/components/course-matrix";

export interface PerformanceRow extends OverviewRow {
  course_id: string;
  final_sha: string | null;
  submitted_at: string | null;
  latest_run_id: string | null;
  assignment: { id: string; title: string; due_at: string };
  course: { id: string; code: string; name: string; term: string; timezone: string; archived_at: string | null };
  reports: { id: string; version: number; generated_at: string }[];
}

export interface FailedCategory {
  category: string;
  failures: number;
}

/**
 * A student's record in an institution: every assignment across all their courses (archived
 * ones included), newest first, with grades and reports. Row-level security decides what the
 * viewer gets: the student sees their own (grades once released), staff their courses.
 */
export async function loadPerformance(supabase: SupabaseClient, institutionId: string, userId: string) {
  const { data: overview } = await supabase
    .from("submission_overview")
    .select(`${OVERVIEW_COLUMNS}, course_id, final_sha, submitted_at, latest_run_id`)
    .eq("institution_id", institutionId)
    .eq("user_id", userId);
  const rows = (overview ?? []) as unknown as Omit<PerformanceRow, "assignment" | "course" | "reports">[];
  if (rows.length === 0) return { rows: [] as PerformanceRow[], failedCategories: [] as FailedCategory[] };

  const runIds = rows.map((r) => r.latest_run_id).filter((id): id is string => Boolean(id));
  const [assignments, courses, reports, failures] = await Promise.all([
    supabase
      .from("assignments")
      .select("id, title, due_at")
      .in(
        "id",
        rows.map((r) => r.assignment_id),
      ),
    supabase
      .from("courses")
      .select("id, code, name, term, timezone, archived_at")
      .in("id", [...new Set(rows.map((r) => r.course_id))]),
    supabase
      .from("grade_reports")
      .select("id, submission_id, version, generated_at")
      .eq("user_id", userId)
      .eq("institution_id", institutionId)
      .order("version", { ascending: false }),
    runIds.length
      ? supabase.from("test_results").select("category, title").in("run_id", runIds).in("status", ["failed", "error"])
      : Promise.resolve({ data: [] as { category: string | null; title: string }[] }),
  ]);
  const assignmentById = new Map((assignments.data ?? []).map((a) => [a.id as string, a]));
  const courseById = new Map((courses.data ?? []).map((c) => [c.id as string, c]));
  const reportsBySubmission = new Map<string, PerformanceRow["reports"]>();
  for (const r of (reports.data ?? []) as (PerformanceRow["reports"][number] & { submission_id: string })[]) {
    reportsBySubmission.set(r.submission_id, [...(reportsBySubmission.get(r.submission_id) ?? []), r]);
  }

  const counts = new Map<string, number>();
  for (const f of (failures.data ?? []) as { category: string | null; title: string }[]) {
    const key = f.category ?? "Uncategorised";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return {
    rows: rows
      .filter((r) => assignmentById.has(r.assignment_id) && courseById.has(r.course_id))
      .map((r) => ({
        ...r,
        assignment: assignmentById.get(r.assignment_id) as PerformanceRow["assignment"],
        course: courseById.get(r.course_id) as PerformanceRow["course"],
        reports: reportsBySubmission.get(r.submission_id) ?? [],
      }))
      .sort((x, y) => y.assignment.due_at.localeCompare(x.assignment.due_at)),
    failedCategories: [...counts.entries()]
      .map(([category, failuresCount]) => ({ category, failures: failuresCount }))
      .sort((a, b) => b.failures - a.failures)
      .slice(0, 5),
  };
}
