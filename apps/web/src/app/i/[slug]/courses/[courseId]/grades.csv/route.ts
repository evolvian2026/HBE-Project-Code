import { toCsv, utcToZonedLocal, type CsvCell } from "@hbe/core";
import { requireCourse } from "@/lib/course";
import { createSupabaseServerClient } from "@/lib/supabase/server";

interface Row {
  submission_id: string;
  assignment_id: string;
  user_id: string;
  status: string;
  late_days: number | null;
  final_sha: string | null;
  submitted_at: string | null;
  final_score: string | null;
  computed_score: string | null;
  late_penalty: string | null;
  override_score: string | null;
  grade_complete: boolean | null;
  grade_released_at_version: string | null;
  grade_components: {
    automated?: { score: number | null };
    rubric?: { score: number | null };
    process?: { score: number | null };
  } | null;
}

/**
 * Course staff export every student's grade on every published assignment (FR-6.8): one row
 * per student and assignment, with components, lateness and release state. Read through RLS.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string; courseId: string }> }) {
  const { slug, courseId } = await params;
  const { course, isCourseStaff, ctx } = await requireCourse(slug, courseId);
  if (!isCourseStaff) return new Response("Only course staff can export grades.", { status: 403 });

  const supabase = await createSupabaseServerClient();
  const [assignments, members, overview, extensions] = await Promise.all([
    supabase
      .from("assignments")
      .select("id, title, due_at")
      .eq("course_id", course.id)
      .neq("status", "draft")
      .order("due_at"),
    supabase
      .from("course_memberships")
      .select("user_id, profile:profiles(full_name, email, github_login)")
      .eq("course_id", course.id)
      .eq("role", "student"),
    supabase
      .from("submission_overview")
      .select(
        "submission_id, assignment_id, user_id, status, late_days, final_sha, submitted_at, final_score, computed_score, late_penalty, override_score, grade_complete, grade_released_at_version, grade_components",
      )
      .eq("course_id", course.id),
    supabase
      .from("assignment_extensions")
      .select("assignment_id, user_id, due_at")
      .eq("institution_id", ctx.institution.id),
  ]);
  const externalIds = new Map(
    (
      (
        await supabase
          .from("institution_memberships")
          .select("user_id, external_id")
          .eq("institution_id", ctx.institution.id)
      ).data ?? []
    ).map((m) => [m.user_id as string, m.external_id as string | null]),
  );
  const students = (
    (members.data ?? []) as unknown as {
      user_id: string;
      profile: { full_name: string | null; email: string | null; github_login: string | null } | null;
    }[]
  ).sort((x, y) =>
    (x.profile?.full_name ?? x.profile?.email ?? "").localeCompare(y.profile?.full_name ?? y.profile?.email ?? ""),
  );
  const rows = new Map(((overview.data ?? []) as unknown as Row[]).map((r) => [`${r.user_id}/${r.assignment_id}`, r]));
  const extended = new Map(
    ((extensions.data ?? []) as { assignment_id: string; user_id: string; due_at: string }[]).map((x) => [
      `${x.user_id}/${x.assignment_id}`,
      x.due_at,
    ]),
  );
  const num = (v: string | number | null | undefined): CsvCell => (v === null || v === undefined ? null : Number(v));
  const time = (v: string | null) => (v ? utcToZonedLocal(new Date(v), course.timezone).replace("T", " ") : null);

  const table: CsvCell[][] = [
    [
      "Student",
      "Email",
      "GitHub",
      "Student ID",
      "Assignment",
      `Due (${course.timezone})`,
      "Status",
      "Graded commit",
      `Pushed at (${course.timezone})`,
      "Days late",
      "Tests",
      "Rubric",
      "Process",
      "Late penalty %",
      "Calculated",
      "Override",
      "Final",
      "Complete",
      "Released",
    ],
  ];
  for (const st of students) {
    for (const a of assignments.data ?? []) {
      const key = `${st.user_id}/${a.id}`;
      const r = rows.get(key);
      const c = r?.grade_components;
      table.push([
        st.profile?.full_name,
        st.profile?.email,
        st.profile?.github_login,
        externalIds.get(st.user_id),
        a.title,
        time(extended.get(key) ?? a.due_at),
        r?.status ?? "no submission",
        r?.final_sha?.slice(0, 7),
        time(r?.submitted_at ?? null),
        r?.late_days,
        num(c?.automated?.score),
        num(c?.rubric?.score),
        num(c?.process?.score),
        num(r?.late_penalty),
        num(r?.computed_score),
        num(r?.override_score),
        num(r?.final_score),
        r?.final_score == null ? null : r.grade_complete ? "yes" : "no",
        r?.grade_released_at_version ? "yes" : r?.final_score == null ? null : "no",
      ]);
    }
  }

  const date = utcToZonedLocal(new Date(), course.timezone).slice(0, 10);
  const filename = `${course.code}-grades-${date}.csv`.replace(/[^A-Za-z0-9._-]/g, "_");
  return new Response("﻿" + toCsv(table), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}
