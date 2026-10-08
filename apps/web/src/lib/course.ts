import { notFound } from "next/navigation";
import { cache } from "react";
import { requireMembership, type InstitutionContext } from "./institution";
import { createSupabaseServerClient } from "./supabase/server";

export interface CourseContext {
  ctx: InstitutionContext;
  course: {
    id: string;
    code: string;
    name: string;
    term: string;
    timezone: string;
    archived_at: string | null;
    github: { account_login: string } | null;
  };
  myCourseRole: "instructor" | "ta" | "student" | null;
  /** Instructors and institution admins (edit content, publish). */
  canManage: boolean;
  /** Instructors, TAs and institution admins (see everyone's work). */
  isCourseStaff: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const requireCourse = cache(async (slug: string, courseId: string): Promise<CourseContext> => {
  const ctx = await requireMembership(slug);
  if (!UUID.test(courseId)) notFound();
  const supabase = await createSupabaseServerClient();
  const [{ data: course }, { data: mine }] = await Promise.all([
    supabase
      .from("courses")
      .select("id, code, name, term, timezone, archived_at, github:github_installations(account_login)")
      .eq("id", courseId)
      .eq("institution_id", ctx.institution.id)
      .maybeSingle(),
    supabase
      .from("course_memberships")
      .select("role")
      .eq("course_id", courseId)
      .eq("user_id", ctx.session.userId)
      .maybeSingle(),
  ]);
  if (!course) notFound();
  const myCourseRole = (mine?.role ?? null) as CourseContext["myCourseRole"];
  return {
    ctx,
    course: course as unknown as CourseContext["course"],
    myCourseRole,
    canManage: ctx.writable && !course.archived_at && (ctx.isAdmin || myCourseRole === "instructor"),
    isCourseStaff: ctx.isAdmin || myCourseRole === "instructor" || myCourseRole === "ta",
  };
});
