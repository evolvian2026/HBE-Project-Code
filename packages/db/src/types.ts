// Kysely table types for the server (api/worker). Mirrors supabase/migrations.
// Keep in step with each migration; the integration test in schema.test.ts checks
// that every column listed here exists in the database.
import type { ColumnType, Generated, Insertable, Selectable, Updateable } from "kysely";

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
type Timestamp = ColumnType<Date, Date | string, Date | string>;
type DefaultTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export type PlatformRole = "super_admin";
export type InstitutionRole = "admin" | "teacher" | "student";
export type CourseRole = "instructor" | "ta" | "student";
export type MembershipStatus = "active" | "deactivated";
export type InstitutionStatus = "active" | "read_only" | "suspended" | "purged";

export interface InstitutionsTable {
  id: Generated<string>;
  name: string;
  slug: string;
  status: Generated<InstitutionStatus>;
  limits: Generated<Json>;
  settings: Generated<Json>;
  contract_started_at: Timestamp | null;
  contract_ended_at: Timestamp | null;
  purge_after: Timestamp | null;
  created_by: string | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface ProfilesTable {
  id: string;
  email: string | null;
  full_name: string | null;
  avatar_url: string | null;
  github_user_id: number | null;
  github_login: string | null;
  status: Generated<MembershipStatus>;
  anonymised_at: Timestamp | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface UserRolesTable {
  user_id: string;
  role: PlatformRole;
  granted_by: string | null;
  created_at: DefaultTimestamp;
}

export interface InstitutionMembershipsTable {
  id: Generated<string>;
  institution_id: string;
  user_id: string;
  role: InstitutionRole;
  status: Generated<MembershipStatus>;
  external_id: string | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface CoursesTable {
  id: Generated<string>;
  institution_id: string;
  code: string;
  name: string;
  term: string;
  timezone: Generated<string>;
  archived_at: Timestamp | null;
  github_installation_id: string | null;
  created_by: string | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface CourseMembershipsTable {
  id: Generated<string>;
  institution_id: string;
  course_id: string;
  user_id: string;
  role: CourseRole;
  section: string | null;
  source: Generated<"manual" | "csv" | "lms" | "invitation">;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface InvitationsTable {
  id: Generated<string>;
  institution_id: string;
  email: string | null;
  github_login: string | null;
  role: InstitutionRole;
  course_id: string | null;
  course_role: CourseRole | null;
  token_hash: string | null;
  invited_by: string | null;
  expires_at: DefaultTimestamp;
  accepted_at: Timestamp | null;
  accepted_by: string | null;
  created_at: DefaultTimestamp;
}

export interface AuditLogsTable {
  id: Generated<number>;
  institution_id: string | null;
  actor_id: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  before: Json | null;
  after: Json | null;
  ip: string | null;
  at: DefaultTimestamp;
}

export interface GithubInstallationsTable {
  id: Generated<string>;
  institution_id: string | null;
  installation_id: number;
  account_id: number;
  account_login: string;
  account_type: "Organization" | "User" | "Enterprise";
  repository_selection: string | null;
  permissions: Generated<Json>;
  events: Generated<string[]>;
  suspended_at: Timestamp | null;
  deleted_at: Timestamp | null;
  linked_at: Timestamp | null;
  linked_by: string | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface GithubLinkRequestsTable {
  id: Generated<string>;
  institution_id: string;
  requested_by: string;
  github_user_id: number;
  expires_at: DefaultTimestamp;
  completed_at: Timestamp | null;
  installation_id: number | null;
  created_at: DefaultTimestamp;
}

export interface GithubEventsTable {
  id: Generated<number>;
  delivery_id: string;
  event: string;
  action: string | null;
  installation_id: number | null;
  institution_id: string | null;
  repository_full_name: string | null;
  sender_id: number | null;
  payload: Json;
  received_at: DefaultTimestamp;
  processed_at: Timestamp | null;
  attempts: Generated<number>;
  error: string | null;
}

export interface EmailOutboxTable {
  id: Generated<number>;
  institution_id: string | null;
  to_email: string;
  template: "invitation";
  payload: Json;
  status: Generated<"pending" | "sent" | "failed">;
  attempts: Generated<number>;
  last_error: string | null;
  created_at: DefaultTimestamp;
  sent_at: Timestamp | null;
}

export interface Database {
  institutions: InstitutionsTable;
  profiles: ProfilesTable;
  user_roles: UserRolesTable;
  institution_memberships: InstitutionMembershipsTable;
  courses: CoursesTable;
  course_memberships: CourseMembershipsTable;
  invitations: InvitationsTable;
  audit_logs: AuditLogsTable;
  github_installations: GithubInstallationsTable;
  github_link_requests: GithubLinkRequestsTable;
  github_events: GithubEventsTable;
  email_outbox: EmailOutboxTable;
}

export type Institution = Selectable<InstitutionsTable>;
export type NewInstitution = Insertable<InstitutionsTable>;
export type InstitutionUpdate = Updateable<InstitutionsTable>;
export type Profile = Selectable<ProfilesTable>;
export type InstitutionMembership = Selectable<InstitutionMembershipsTable>;
export type GithubInstallation = Selectable<GithubInstallationsTable>;
export type GithubEvent = Selectable<GithubEventsTable>;
