# Data Model (Supabase Postgres)

This is a design sketch. The real schema will live in `supabase/migrations/`.

Conventions:
- Every table has `id uuid primary key default gen_random_uuid()` and
  `created_at timestamptz default now()`, unless shown otherwise.
- RLS is enabled on every table in `public`.
- **Every tenant-owned table has `institution_id uuid not null`**, including child tables. It is
  part of a `unique (institution_id, id)` constraint, so children can use **composite foreign
  keys** `(institution_id, parent_id) references parent (institution_id, id)`. The database
  itself then refuses a row in institution A that points at a parent in institution B.

## 1. Entity overview

```mermaid
erDiagram
  institutions ||--o{ institution_memberships : has
  institutions ||--o{ courses : has
  institutions ||--o{ github_installations : connects
  institutions ||--o{ lms_connections : configures
  institutions ||--o{ stack_profiles : "owns (or global)"
  profiles ||--o{ institution_memberships : joins
  profiles ||--o{ course_memberships : joins
  courses ||--o{ course_memberships : has
  courses ||--o{ teams : has
  teams ||--o{ team_members : has
  courses ||--o{ assignments : has
  assignments }o--|| stack_profiles : "locked to"
  assignments }o--|| grader_suites : "pins version"
  assignments ||--o| rubrics : uses
  rubrics ||--o{ rubric_criteria : has
  assignments ||--o{ submissions : has
  submissions ||--|| repositories : "tracked in"
  submissions ||--o{ evaluation_runs : has
  evaluation_runs ||--o{ test_results : has
  submissions ||--o{ submission_snapshots : archives
  submissions ||--o{ grades : receives
  grades ||--o{ grade_reports : "rendered as"
  grades ||--o{ lms_grade_syncs : "pushed via"
  repositories ||--o{ commits : has
  repositories ||--o{ pull_requests : has
  repositories ||--o{ issues : has
  submissions ||--o{ feedback : receives
  submissions ||--o{ rubric_scores : receives
  submissions ||--o{ process_snapshots : receives
  courses ||--o{ lms_course_links : "linked to"
  assignments ||--o{ lms_assignment_links : "linked to"
```

## 2. Tables

### Tenancy, identity & access
| Table | Key columns | Notes |
|-------|-------------|-------|
| `institutions` | name, slug unique, status (`active`/`suspended`), data_region, limits jsonb (max users, runs/day, concurrency, storage), settings jsonb (branding, retention_years, process-policy defaults) | Created by a super admin. |
| `profiles` | `id` = `auth.users.id`, full_name, email, avatar_url, github_user_id bigint unique, github_login, status, anonymised_at | Global (a person can be in several institutions). Created by a trigger on `auth.users` insert. |
| `user_roles` | user_id, role (`super_admin`) | Platform-level role only. |
| `institution_memberships` | institution_id, user_id, role (`admin`/`teacher`/`student`), external_id (student number), status | unique(institution_id, user_id). Read by the Custom Access Token Hook. |
| `invitations` | institution_id, email, github_login, role, course_id, course_role, token_hash, expires_at, accepted_at | |
| `sso_providers` | institution_id, supabase_sso_provider_id, domains text[] | SAML through Supabase SSO. |
| `support_access_grants` | institution_id, granted_to (super admin), granted_by, expires_at, reason | Required for super admins to read tenant data. |

### Courses & teams
| Table | Key columns | Notes |
|-------|-------------|-------|
| `courses` | institution_id, code, name, term, timezone, github_installation_id, archived_at | |
| `course_memberships` | institution_id, course_id, user_id, role (`instructor`/`ta`/`student`), section, source (`manual`/`csv`/`lms`) | unique(course_id, user_id) |
| `teams` / `team_members` | institution_id, course_id, name, github_team_slug / team_id, user_id | |

### Stack profiles, assignments & evaluation config
| Table | Key columns | Notes |
|-------|-------------|-------|
| `stack_profiles` | institution_id **nullable** (null = global), key, version, display_name, definition jsonb (services, datastores, stages, ignore_paths), template_repo, status | Immutable once used; edits create a new version. unique(institution_id, key, version). |
| `institution_stack_profiles` | institution_id, stack_profile_id, enabled | Which global profiles an institution has enabled. |
| `assignments` | institution_id, course_id, slug, title, spec_md, mode (`individual`/`team`), **stack_profile_id**, template_repo, release_at, due_at, late_policy jsonb, triggers jsonb, weights jsonb, **process_policy jsonb**, process_policy_version, run_quota_per_day, grader_suite_id, rubric_id, status (`draft`/`published`/`closed`), grades_released_at | Stack profile can't be changed after publishing (trigger-enforced). |
| `extensions` | institution_id, assignment_id, user_id or team_id, due_at, reason, granted_by | Effective deadline = max(due_at, extension). |
| `grader_suites` | institution_id, key, version, git_ref, stack_profile_id (nullable = stack-agnostic), manifest jsonb (tests, titles, hints, weights, categories) | Immutable once published. |
| `rubrics` / `rubric_criteria` | institution_id, title / rubric_id, name, description, max_points, levels jsonb, position | |

### GitHub
| Table | Key columns | Notes |
|-------|-------------|-------|
| `github_installations` | institution_id, installation_id bigint unique, account_login, account_type, permissions jsonb, suspended_at | Maps each installation to exactly one institution. |
| `repositories` | institution_id, github_repo_id bigint unique, installation_id, full_name, default_branch, private, archived | |
| `github_events` | institution_id (nullable until resolved), delivery_id text unique, event, action, installation_id, payload jsonb, received_at, processed_at, error | Raw inbox; pruned after 90 days. |
| `commits` | institution_id, repository_id, sha, author_github_id, author_profile_id, co_author_profile_ids uuid[], message, authored_at, pushed_at, additions, deletions, files_changed, branch, **is_meaningful bool**, exclusion_reason | unique(repository_id, sha) |
| `commit_claims` | institution_id, commit_id, claimed_by, status, reviewed_by | Students claiming unattributed commits. |
| `pull_requests` | institution_id, repository_id, number, github_node_id, author_profile_id, title, has_description, linked_issue_numbers int[], state, merged_at, opened_at, closed_at, review_count | |
| `pr_reviews` | institution_id, pull_request_id, reviewer_profile_id, state, submitted_at | |
| `issues` | institution_id, repository_id, number, author_profile_id, title, state, labels text[], opened_at, closed_at | |
| `activity_daily` | institution_id, submission_id, user_id, day, commits, meaningful_commits, additions, deletions, prs_opened, prs_merged, issues_closed | Nightly rollup. |

### Submissions, runs & grading
| Table | Key columns | Notes |
|-------|-------------|-------|
| `submissions` | institution_id, assignment_id, user_id or team_id, repository_id, status (`provisioning`/`active`/`submitted`/`graded`), final_sha | One per student/team per assignment. |
| `evaluation_runs` | institution_id, submission_id, sha, stack_profile_id, grader_suite_id, trigger, status (`queued`/`dispatched`/`running`/`completed`/`failed`/`infra_error`/`cancelled`), gh_workflow_run_id, score, summary jsonb, artifacts_prefix, artifacts_expire_at (null = permanent), queued_at, started_at, finished_at, requested_by | |
| `test_results` | institution_id, run_id, stage, test_key, title, category, status, weight, duration_ms, expected, actual, message, hint, evidence jsonb, **staff_notes** | Students read through the `student_test_results` view, which leaves out `staff_notes`. |
| `process_snapshots` | institution_id, submission_id, user_id, computed_at, policy_version, score, breakdown jsonb, is_final | Frozen at the deadline; recomputed while the assignment is open. |
| `feedback` | institution_id, submission_id, author_id, body_md, file_path, line, sha, github_comment_id, released | |
| `rubric_scores` | institution_id, submission_id, criterion_id, points, comment, scored_by | unique(submission_id, criterion_id) |
| `grades` | institution_id, submission_id, user_id, version int, evaluation_run_id, process_snapshot_id, components jsonb, late_penalty, computed_score, override_score, override_reason, is_current, released_at | **Append-only**; a new version on every change; one `is_current` per (submission, user). |
| `regrade_requests` | institution_id, submission_id, requested_by, message, status, resolved_by, resolution | |

### Records (permanent)
| Table | Key columns | Notes |
|-------|-------------|-------|
| `submission_snapshots` | institution_id, submission_id, sha, reason (`graded_run`/`deadline`/`regrade`), bundle_path, tarball_path, size_bytes, sha256, replicated_at | No UPDATE/DELETE grants; deletion only through the retention/erasure workflow. |
| `grade_reports` | institution_id, grade_id, version, json_path, pdf_path, sha256, generated_at, generated_by | Immutable; one row per report version. |
| `retention_actions` | institution_id, subject_user_id, action (`anonymise`/`delete`), requested_by, approved_by, executed_at, scope jsonb | Audit of erasure handling. |

### LMS
| Table | Key columns | Notes |
|-------|-------------|-------|
| `lms_connections` | institution_id, type (`canvas`/`moodle`/`google_classroom`), name, issuer, client_id, deployment_ids text[], auth_login_url, auth_token_url, jwks_url, oauth_secrets_encrypted bytea, status | LTI 1.3 platform details or Google OAuth config. |
| `lms_user_links` | institution_id, lms_connection_id, lms_user_id, profile_id, matched_by (`email`/`admin`/`launch`) | unique(lms_connection_id, lms_user_id) |
| `lms_course_links` | institution_id, course_id, lms_connection_id, lms_course_id, context_id, nrps_url | |
| `lms_assignment_links` | institution_id, assignment_id, lms_course_link_id, lineitem_url or classroom_coursework_id, score_maximum | |
| `lms_grade_syncs` | institution_id, grade_id, grade_version, lms_assignment_link_id, status (`pending`/`synced`/`failed`/`conflict`), attempts, last_error, lms_response jsonb, synced_at | unique(grade_id, grade_version, lms_assignment_link_id), which makes syncs idempotent. |

### Platform
| Table | Key columns | Notes |
|-------|-------------|-------|
| `notifications` | institution_id, user_id, type, payload jsonb, read_at | Realtime-subscribed. |
| `institution_settings` / `platform_settings` | key, value jsonb, updated_by | Per tenant / global. |
| `audit_logs` | institution_id (nullable for platform actions), actor_id, action, entity, entity_id, before jsonb, after jsonb, ip, at | Append-only. |
| `usage_counters` | institution_id, period (month), runs, actions_minutes, storage_bytes | For limits and reporting. |

## 3. RLS pattern

```sql
-- Institutions the current user belongs to (from the JWT claim written by the access token hook)
create function public.current_institution_ids() returns uuid[]
language sql stable as $$
  select coalesce(
    array(select (x->>'institution_id')::uuid
          from jsonb_array_elements(auth.jwt()->'institutions') x),
    '{}');
$$;

create function public.is_institution_admin(iid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.institution_memberships
                 where institution_id = iid and user_id = (select auth.uid())
                   and role = 'admin' and status = 'active');
$$;

create function public.is_course_staff(cid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.course_memberships
                 where course_id = cid and user_id = (select auth.uid())
                   and role in ('instructor','ta'));
$$;

create function public.owns_submission(sid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.submissions s
    left join public.team_members tm on tm.team_id = s.team_id
    where s.id = sid and (s.user_id = (select auth.uid()) or tm.user_id = (select auth.uid())));
$$;

-- Example: evaluation runs. The tenant check comes first, then the role check.
alter table public.evaluation_runs enable row level security;

create policy "tenant: students read own runs" on public.evaluation_runs
  for select to authenticated
  using (institution_id = any (public.current_institution_ids())
         and public.owns_submission(submission_id));

create policy "tenant: staff and admins read runs" on public.evaluation_runs
  for select to authenticated
  using (institution_id = any (public.current_institution_ids())
         and (public.is_institution_admin(institution_id)
              or public.is_course_staff(
                   (select a.course_id from public.submissions s
                    join public.assignments a on a.id = s.assignment_id
                    where s.id = submission_id))));

-- No insert/update policies: only the service role (worker) writes runs.

-- Students see grades and reports only after release
create policy "students read released grades" on public.grades
  for select to authenticated
  using (institution_id = any (public.current_institution_ids())
         and released_at is not null and is_current
         and user_id = (select auth.uid()));
```

Tenant isolation is tested with pgTAP. For every table, create two institutions with data,
sign in as each role in institution A, and assert that zero rows from B are returned.

## 4. Indexes worth having from day one

- `(institution_id, …)` leading every list-style index, e.g. `submissions (institution_id, assignment_id)`
- `commits (repository_id, authored_at desc)`, `commits (author_profile_id, authored_at)`
- `evaluation_runs (submission_id, queued_at desc)`, partial index `where status in ('queued','dispatched','running')`
- `grades (institution_id, user_id) where is_current`; `grade_reports (grade_id, version desc)`
- `lms_grade_syncs (status) where status in ('pending','failed')`
- `github_events (processed_at) where processed_at is null`
- `notifications (user_id) where read_at is null`
- every foreign key column (Supabase's linter flags missing ones)
- Records grow without limit. Consider partitioning `test_results` and `commits` by year once
  they pass about 50 M rows.
