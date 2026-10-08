import type { PlanContext } from "@hbe/core";
import type { createSupabaseServerClient } from "@/lib/supabase/server";

type Supabase = Awaited<ReturnType<typeof createSupabaseServerClient>>;

export interface MemberRow {
  id: string;
  user_id: string;
  role: "admin" | "teacher" | "student";
  status: "active" | "deactivated";
  profile: { full_name: string | null; email: string | null; github_login: string | null } | null;
}

export async function loadMembers(supabase: Supabase, institutionId: string): Promise<MemberRow[]> {
  const { data } = await supabase
    .from("institution_memberships")
    .select(
      "id, user_id, role, status, profile:profiles!institution_memberships_user_id_fkey(full_name, email, github_login)",
    )
    .eq("institution_id", institutionId);
  return ((data ?? []) as unknown as MemberRow[]).sort(
    (a, b) =>
      a.role.localeCompare(b.role) ||
      (a.profile?.full_name ?? a.profile?.email ?? "").localeCompare(b.profile?.full_name ?? b.profile?.email ?? ""),
  );
}

/** Everything the invitation planner needs, read with the user's own permissions. */
export async function loadPlanContext(supabase: Supabase, institutionId: string): Promise<PlanContext> {
  const [members, invitations, courses, courseMembers] = await Promise.all([
    loadMembers(supabase, institutionId),
    supabase
      .from("invitations")
      .select("email, github_login, course_id")
      .eq("institution_id", institutionId)
      .is("accepted_at", null),
    supabase.from("courses").select("id, code, term, archived_at").eq("institution_id", institutionId),
    supabase.from("course_memberships").select("course_id, user_id").eq("institution_id", institutionId),
  ]);
  return {
    members: members.map((m) => ({
      userId: m.user_id,
      email: m.profile?.email ?? null,
      githubLogin: m.profile?.github_login ?? null,
      status: m.status,
    })),
    pendingInvitations: (invitations.data ?? []).map((i) => ({
      email: i.email,
      githubLogin: i.github_login,
      courseId: i.course_id,
    })),
    courses: (courses.data ?? []).map((c) => ({
      id: c.id,
      code: c.code,
      term: c.term,
      archived: Boolean(c.archived_at),
    })),
    courseMembers: (courseMembers.data ?? []).map((cm) => ({ courseId: cm.course_id, userId: cm.user_id })),
  };
}
