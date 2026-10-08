import type { InstitutionRole } from "@hbe/core";
import { redirect } from "next/navigation";
import { cache } from "react";
import { createSupabaseServerClient } from "./supabase/server";

export interface MembershipView {
  role: InstitutionRole;
  institution: { id: string; name: string; slug: string; status: string };
}

export interface SessionContext {
  userId: string;
  email: string | null;
  fullName: string | null;
  githubLogin: string | null;
  isSuperAdmin: boolean;
  memberships: MembershipView[];
}

/**
 * The signed-in user and what they belong to, read through RLS. Redirects to /login
 * when there is no valid session. Cached per request.
 */
export const requireSession = cache(async (): Promise<SessionContext> => {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getClaims();
  const userId = data?.claims?.sub;
  if (!userId) redirect("/login");

  const [profile, roles, memberships] = await Promise.all([
    supabase.from("profiles").select("email, full_name, github_login").eq("id", userId).maybeSingle(),
    supabase.from("user_roles").select("role").eq("user_id", userId),
    supabase
      .from("institution_memberships")
      .select("role, institution:institutions!inner(id, name, slug, status)")
      .eq("user_id", userId)
      .eq("status", "active"),
  ]);

  return {
    userId,
    email: profile.data?.email ?? null,
    fullName: profile.data?.full_name ?? null,
    githubLogin: profile.data?.github_login ?? null,
    isSuperAdmin: (roles.data ?? []).some((r) => r.role === "super_admin"),
    memberships: ((memberships.data ?? []) as unknown as MembershipView[]).sort((a, b) =>
      a.institution.name.localeCompare(b.institution.name),
    ),
  };
});
