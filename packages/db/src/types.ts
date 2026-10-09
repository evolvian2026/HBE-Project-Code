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
  email_notification_types: Generated<NotificationType[]>;
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
  template: "invitation" | "notification";
  payload: Json;
  status: Generated<"pending" | "sent" | "failed">;
  attempts: Generated<number>;
  last_error: string | null;
  created_at: DefaultTimestamp;
  sent_at: Timestamp | null;
}

export interface PlatformSettingsTable {
  key: string;
  value: Json;
  description: string | null;
  updated_by: string | null;
  updated_at: DefaultTimestamp;
}

export type AssignmentStatus = "draft" | "published" | "closed";
export type SubmissionStatus =
  "waiting_for_github" | "provisioning" | "active" | "provisioning_failed" | "submitted" | "missing" | "graded";

export interface StackProfilesTable {
  id: Generated<string>;
  institution_id: string | null;
  key: string;
  version: number;
  display_name: string;
  description: string | null;
  definition: Json;
  status: Generated<"active" | "retired">;
  created_at: DefaultTimestamp;
}

export interface AssignmentsTable {
  id: Generated<string>;
  institution_id: string;
  course_id: string;
  slug: string;
  title: string;
  spec_md: Generated<string>;
  stack_profile_id: string;
  template_repo: string | null;
  release_at: Timestamp | null;
  due_at: Timestamp;
  late_policy: Generated<Json>;
  weights: Generated<Json>;
  process_policy: Generated<Json>;
  triggers: Generated<Json>;
  run_quota_per_day: Generated<number>;
  grader_suite_id: string | null;
  status: Generated<AssignmentStatus>;
  published_at: Timestamp | null;
  grades_released_at: Timestamp | null;
  regrade_window_days: Generated<number>;
  stage_settings: Generated<Json>;
  created_by: string | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface AssignmentCriteriaTable {
  id: Generated<string>;
  institution_id: string;
  assignment_id: string;
  title: string;
  description: string | null;
  max_points: string; // numeric
  position: Generated<number>;
  created_at: DefaultTimestamp;
}

export interface AssignmentExtensionsTable {
  id: Generated<string>;
  institution_id: string;
  assignment_id: string;
  user_id: string;
  due_at: Timestamp;
  reason: string | null;
  granted_by: string | null;
  created_at: DefaultTimestamp;
}

export interface RepositoriesTable {
  id: Generated<string>;
  institution_id: string;
  github_installation_id: string;
  owner: string;
  name: string;
  github_repo_id: number | null;
  default_branch: Generated<string>;
  private: Generated<boolean>;
  archived: Generated<boolean>;
  head_sha: string | null;
  head_pushed_at: Timestamp | null;
  /** The commit the student started from (the template's), cached. */
  start_sha: string | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface SubmissionsTable {
  id: Generated<string>;
  institution_id: string;
  assignment_id: string;
  user_id: string;
  repository_id: string | null;
  status: Generated<SubmissionStatus>;
  status_detail: string | null;
  provisioning_attempts: Generated<number>;
  final_sha: string | null;
  /** GitHub's push time of the graded commit. */
  submitted_at: Timestamp | null;
  late_days: number | null;
  finalized_at: Timestamp | null;
  grade_released_at: Timestamp | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface RubricScoresTable {
  id: Generated<string>;
  institution_id: string;
  submission_id: string;
  criterion_id: string;
  points: string; // numeric
  comment: string | null;
  scored_by: string | null;
  scored_at: DefaultTimestamp;
}

export interface FeedbackTable {
  id: Generated<string>;
  institution_id: string;
  submission_id: string;
  body_md: Generated<string>;
  author_id: string | null;
  updated_at: DefaultTimestamp;
}

/** Append-only grade versions; one is_current per submission. */
export interface GradesTable {
  id: Generated<string>;
  institution_id: string;
  submission_id: string;
  user_id: string;
  version: number;
  evaluation_run_id: string | null;
  components: Json;
  late_days: Generated<number>;
  late_penalty: Generated<string>; // numeric
  computed_score: string; // numeric
  override_score: string | null; // numeric
  override_reason: string | null;
  final_score: string; // numeric
  complete: boolean;
  is_current: Generated<boolean>;
  released_at: Timestamp | null;
  created_by: string | null;
  created_at: DefaultTimestamp;
}

/** Pushes to a repository's default branch, by GitHub's push time. */
export interface BranchPushesTable {
  id: Generated<number>;
  institution_id: string;
  repository_id: string;
  sha: string;
  pushed_at: Timestamp;
  pusher_github_id: number | null;
  by_bot: Generated<boolean>;
  forced: Generated<boolean>;
  received_at: DefaultTimestamp;
}

/** One immutable report (JSON + PDF in Storage) per released grade version. */
export interface GradeReportsTable {
  id: Generated<string>;
  institution_id: string;
  submission_id: string;
  grade_id: string;
  user_id: string;
  version: number;
  grade_version: number;
  json_path: string;
  pdf_path: string;
  sha256: string;
  pdf_sha256: string;
  generated_at: DefaultTimestamp;
}

/** Source of a graded commit, archived by the grader job. */
export interface SubmissionSnapshotsTable {
  id: Generated<string>;
  institution_id: string;
  submission_id: string;
  run_id: string | null;
  sha: string;
  bundle_path: string;
  bundle_sha256: string;
  bundle_size: number;
  tarball_path: string;
  tarball_sha256: string;
  tarball_size: number;
  created_at: DefaultTimestamp;
}

export type NotificationType =
  "run_finished" | "grade_released" | "deadline_soon" | "extension_granted" | "regrade_requested" | "regrade_answered";

export interface NotificationsTable {
  id: Generated<string>;
  institution_id: string;
  user_id: string;
  type: NotificationType;
  title: string;
  body: string | null;
  link: string | null;
  dedupe_key: string | null;
  created_at: DefaultTimestamp;
  read_at: Timestamp | null;
}

export interface ReviewCommentsTable {
  id: Generated<string>;
  institution_id: string;
  submission_id: string;
  sha: string;
  path: string;
  line: number;
  body: string;
  author_id: string | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface RunArtifactsTable {
  id: Generated<string>;
  institution_id: string;
  run_id: string;
  name: string;
  path: string;
  content_type: "image/png" | "application/zip" | "text/plain" | "application/xml";
  size: number;
  expires_at: Timestamp | null;
  created_at: DefaultTimestamp;
}

export type RegradeStatus = "open" | "accepted" | "declined" | "withdrawn";

export interface RegradeRequestsTable {
  id: Generated<string>;
  institution_id: string;
  submission_id: string;
  requested_by: string | null;
  message: string;
  status: Generated<RegradeStatus>;
  response: string | null;
  resolved_by: string | null;
  resolved_at: Timestamp | null;
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface CommitsTable {
  id: Generated<string>;
  institution_id: string;
  repository_id: string;
  sha: string;
  branch: string | null;
  message: Generated<string>;
  authored_at: Timestamp;
  pushed_at: DefaultTimestamp;
  author_login: string | null;
  author_github_id: number | null;
  author_profile_id: string | null;
  details_status: Generated<"pending" | "done" | "unavailable">;
  parent_count: number | null;
  additions: number | null;
  deletions: number | null;
  files_changed: number | null;
  effective_lines: number | null;
  is_bot: Generated<boolean>;
  created_at: DefaultTimestamp;
}

export interface PullRequestsTable {
  id: Generated<string>;
  institution_id: string;
  repository_id: string;
  number: number;
  github_id: number;
  author_github_id: number | null;
  author_profile_id: string | null;
  title: Generated<string>;
  body_length: Generated<number>;
  linked_issues: Generated<number[]>;
  state: "open" | "closed" | "merged";
  review_count: Generated<number>;
  opened_at: Timestamp;
  closed_at: Timestamp | null;
  merged_at: Timestamp | null;
  updated_at: DefaultTimestamp;
}

export interface PrReviewsTable {
  id: Generated<string>;
  institution_id: string;
  repository_id: string;
  pr_number: number;
  github_review_id: number;
  reviewer_github_id: number | null;
  reviewer_profile_id: string | null;
  state: string;
  submitted_at: Timestamp;
}

export interface IssuesTable {
  id: Generated<string>;
  institution_id: string;
  repository_id: string;
  number: number;
  github_id: number;
  author_github_id: number | null;
  author_profile_id: string | null;
  title: Generated<string>;
  state: "open" | "closed";
  opened_at: Timestamp;
  closed_at: Timestamp | null;
  updated_at: DefaultTimestamp;
}

export interface ProcessSnapshotsTable {
  id: Generated<string>;
  institution_id: string;
  submission_id: string;
  score: string; // numeric
  breakdown: Json;
  policy: Json;
  is_final: Generated<boolean>;
  computed_at: DefaultTimestamp;
}

export type RunStatus = "queued" | "dispatched" | "running" | "completed" | "failed" | "infra_error" | "cancelled";

export interface GraderSuitesTable {
  id: Generated<string>;
  institution_id: string | null;
  key: string;
  version: number;
  title: string;
  path: string;
  git_ref: Generated<string>;
  stack_profile_id: string | null;
  manifest: Generated<Json>;
  status: Generated<"active" | "retired">;
  created_at: DefaultTimestamp;
}

export interface EvaluationRunsTable {
  id: Generated<string>;
  institution_id: string;
  submission_id: string;
  sha: string;
  trigger: "push" | "pull_request" | "manual" | "deadline" | "regrade";
  status: Generated<RunStatus>;
  grader_suite_id: string | null;
  stack_profile_id: string | null;
  score: string | null; // numeric
  summary: Json | null;
  error: string | null;
  requested_by: string | null;
  callback_token_hash: string | null;
  gh_workflow_run_id: number | null;
  check_run_id: number | null;
  queued_at: DefaultTimestamp;
  dispatched_at: Timestamp | null;
  started_at: Timestamp | null;
  finished_at: Timestamp | null;
}

export interface TestResultsTable {
  id: Generated<string>;
  institution_id: string;
  run_id: string;
  stage: string;
  test_key: string;
  title: string;
  category: string | null;
  status: "passed" | "failed" | "skipped" | "error";
  weight: Generated<string>; // numeric
  duration_ms: number | null;
  expected: string | null;
  actual: string | null;
  message: string | null;
  hint: string | null;
  evidence: Json | null;
  attachments: Json | null;
  staff_notes: string | null;
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
  platform_settings: PlatformSettingsTable;
  stack_profiles: StackProfilesTable;
  assignments: AssignmentsTable;
  assignment_criteria: AssignmentCriteriaTable;
  assignment_extensions: AssignmentExtensionsTable;
  repositories: RepositoriesTable;
  submissions: SubmissionsTable;
  commits: CommitsTable;
  pull_requests: PullRequestsTable;
  pr_reviews: PrReviewsTable;
  issues: IssuesTable;
  process_snapshots: ProcessSnapshotsTable;
  grader_suites: GraderSuitesTable;
  evaluation_runs: EvaluationRunsTable;
  test_results: TestResultsTable;
  branch_pushes: BranchPushesTable;
  rubric_scores: RubricScoresTable;
  feedback: FeedbackTable;
  grades: GradesTable;
  grade_reports: GradeReportsTable;
  submission_snapshots: SubmissionSnapshotsTable;
  notifications: NotificationsTable;
  review_comments: ReviewCommentsTable;
  regrade_requests: RegradeRequestsTable;
  run_artifacts: RunArtifactsTable;
}

export type Institution = Selectable<InstitutionsTable>;
export type NewInstitution = Insertable<InstitutionsTable>;
export type InstitutionUpdate = Updateable<InstitutionsTable>;
export type Profile = Selectable<ProfilesTable>;
export type InstitutionMembership = Selectable<InstitutionMembershipsTable>;
export type GithubInstallation = Selectable<GithubInstallationsTable>;
export type GithubEvent = Selectable<GithubEventsTable>;
