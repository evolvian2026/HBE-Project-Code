// Authorisation rules for server code, which bypasses RLS. They mirror the
// policies in supabase/migrations; the database remains the second line of defence.
export type InstitutionRole = "admin" | "teacher" | "student";

export interface Actor {
  userId: string;
  /** Super admin AND (MFA passed or not required): see mfaSatisfied. */
  isSuperAdmin: boolean;
  /** Session passed MFA (aal2), or the platform does not require it for admins. */
  mfaSatisfied: boolean;
  githubUserId: number | null;
  /** Active memberships in usable (active or read-only) institutions. */
  memberships: ReadonlyMap<string, { role: InstitutionRole; institutionStatus: InstitutionStatus }>;
}

export type InstitutionStatus = "active" | "read_only" | "suspended" | "purged";

export class ForbiddenError extends Error {
  readonly statusCode = 403;
  constructor(message = "You do not have permission to do that") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/** Effective role: an admin without MFA has no admin powers (mirrors the database rule). */
export function roleIn(actor: Actor, institutionId: string): InstitutionRole | null {
  const role = actor.memberships.get(institutionId)?.role ?? null;
  return role === "admin" && !actor.mfaSatisfied ? null : role;
}

const can = {
  createInstitution: (a: Actor) => a.isSuperAdmin,
  listAllInstitutions: (a: Actor) => a.isSuperAdmin,
  inviteInstitutionAdmin: (a: Actor, institutionId: string) => a.isSuperAdmin || roleIn(a, institutionId) === "admin",
  manageInstitution: (a: Actor, institutionId: string) =>
    roleIn(a, institutionId) === "admin" && a.memberships.get(institutionId)?.institutionStatus === "active",
  linkGithubInstallation: (a: Actor, institutionId: string) =>
    roleIn(a, institutionId) === "admin" && a.memberships.get(institutionId)?.institutionStatus === "active",
  mapGithubInstallationManually: (a: Actor) => a.isSuperAdmin,
  /** Instructors of the course, or the institution's admins (active institutions only). */
  manageCourse: (a: Actor, institutionId: string, courseRole: string | null) =>
    (roleIn(a, institutionId) === "admin" || courseRole === "instructor") &&
    a.memberships.get(institutionId)?.institutionStatus === "active",
} as const;

export type Permission = keyof typeof can;

export function allowed<P extends Permission>(
  actor: Actor,
  permission: P,
  ...args: Parameters<(typeof can)[P]> extends [Actor, ...infer R] ? R : never
): boolean {
  return (can[permission] as (a: Actor, ...rest: unknown[]) => boolean)(actor, ...args);
}

export function authorize<P extends Permission>(
  actor: Actor,
  permission: P,
  ...args: Parameters<(typeof can)[P]> extends [Actor, ...infer R] ? R : never
): void {
  if (!allowed(actor, permission, ...args)) throw new ForbiddenError();
}
