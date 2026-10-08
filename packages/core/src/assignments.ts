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
  return problems;
}

/** Repository name for a student's copy: {assignment-slug}-{github-login}, GitHub's 100-char limit. */
export function repositoryName(assignmentSlug: string, githubLogin: string): string {
  return `${assignmentSlug}-${githubLogin}`.toLowerCase().slice(0, 100);
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
