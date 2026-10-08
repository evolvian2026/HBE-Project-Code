import type { InstitutionRole } from "@hbe/core";
import { notFound } from "next/navigation";
import { cache } from "react";
import { enforceAdminMfa } from "./mfa";
import { requireSession, type SessionContext } from "./session";

export interface InstitutionContext {
  session: SessionContext;
  institution: { id: string; name: string; slug: string; status: string };
  role: InstitutionRole;
  isAdmin: boolean;
  isStaff: boolean;
  writable: boolean;
}

/** The signed-in user's membership in the institution at /i/[slug], or a 404. */
export const requireMembership = cache(async (slug: string): Promise<InstitutionContext> => {
  const session = await requireSession();
  const membership = session.memberships.find((m) => m.institution.slug === slug);
  if (!membership) notFound();
  if (membership.role === "admin") await enforceAdminMfa(`/i/${slug}`);
  return {
    session,
    institution: membership.institution,
    role: membership.role,
    isAdmin: membership.role === "admin",
    isStaff: membership.role === "admin" || membership.role === "teacher",
    writable: membership.institution.status === "active",
  };
});
