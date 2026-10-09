/** Assignment rules shared by the API (publishing) and the web app (forms). */

export const ASSIGNMENT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;

export interface Weights {
  automated: number;
  rubric: number;
  process: number;
}

export interface LatePolicy {
  per_day_percent: number;
  max_days: number;
  grace_minutes: number;
}

export interface PublishCheckInput {
  status: string;
  dueAt: Date;
  releaseAt: Date | null;
  templateRepo: string | null;
  stackProfileStatus: string;
  courseArchived: boolean;
  courseInstallation: { suspended: boolean; deleted: boolean } | null;
  rubricCriteriaCount: number;
  weights: Weights;
  hasGraderSuite: boolean;
  now?: Date;
}

/** Everything that must be true before students get repositories. Empty = ready. */
export function publishProblems(a: PublishCheckInput): string[] {
  const now = a.now ?? new Date();
  const problems: string[] = [];
  if (a.status !== "draft") problems.push("Only draft assignments can be published.");
  if (a.dueAt <= now) problems.push("The due date is in the past.");
  if (a.releaseAt && a.releaseAt >= a.dueAt) problems.push("The release date must be before the due date.");
  if (!a.templateRepo) problems.push("Set the template repository students start from.");
  if (a.stackProfileStatus !== "active") problems.push("The stack profile has been retired; choose another.");
  if (a.courseArchived) problems.push("The course is archived.");
  if (!a.courseInstallation || a.courseInstallation.deleted) {
    problems.push("Connect the course to a GitHub organisation first (course settings).");
  } else if (a.courseInstallation.suspended) {
    problems.push("The course's GitHub App installation is suspended.");
  }
  if (a.weights.rubric > 0 && a.rubricCriteriaCount === 0) {
    problems.push("Add rubric criteria, or set the rubric weight to 0.");
  }
  if (a.weights.automated > 0 && !a.hasGraderSuite) {
    problems.push("Choose a hidden test suite, or set the automated tests weight to 0.");
  }
  return problems;
}

/** Repository name for a student's copy: {assignment-slug}-{github-login}, GitHub's 100-char limit. */
export function repositoryName(assignmentSlug: string, githubLogin: string): string {
  return `${assignmentSlug}-${githubLogin}`.toLowerCase().slice(0, 100);
}

/**
 * A team's repository name: `{assignment-slug}-{team-slug}-{6 characters of the team id}`, so
 * teams with the same name in different courses never share a repository.
 */
export function teamRepositoryName(assignmentSlug: string, teamSlug: string, teamId: string): string {
  const suffix = teamId.replace(/-/g, "").slice(0, 6);
  return `${assignmentSlug}-${teamSlug.slice(0, 40)}-${suffix}`.toLowerCase().slice(0, 100);
}

export function slugifyAssignment(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

const DAY_MS = 86_400_000;

/**
 * When a submission's graded commit is fixed: the (extended) deadline plus the grace period,
 * plus the late window when late work is accepted. The graded commit is the default branch's
 * head as of then, by GitHub's push time.
 */
export function submissionCutoff(deadline: Date, policy: LatePolicy): Date {
  return new Date(deadline.getTime() + policy.grace_minutes * 60_000 + policy.max_days * DAY_MS);
}

/** Started days late for a push (0 within the grace period), at most the late window. */
export function lateDays(pushedAt: Date, deadline: Date, policy: LatePolicy): number {
  const late = pushedAt.getTime() - deadline.getTime();
  if (late <= policy.grace_minutes * 60_000) return 0;
  return Math.min(policy.max_days, Math.ceil(late / DAY_MS));
}
