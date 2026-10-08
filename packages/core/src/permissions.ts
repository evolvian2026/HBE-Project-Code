// Authorisation rules for server code, which bypasses RLS. They mirror the
// policies in supabase/migrations; the database remains the second line of defence.
export type InstitutionRole = "admin" | "teacher" | "student";

export interface Actor {
  userId: string;
  isSuperAdmin: boolean;
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

export function roleIn(actor: Actor, institutionId: string): InstitutionRole | null {
  return actor.memberships.get(institutionId)?.role ?? null;
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
