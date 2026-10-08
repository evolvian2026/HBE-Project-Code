import { randomUUID } from "node:crypto";
import type { Db } from "@hbe/db";
import { randomGithubId, unique, type Fixtures } from "./helpers.ts";

export const sha = () => randomUUID().replace(/-/g, "").padEnd(40, "0").slice(0, 40);

export interface Scenario {
  institutionId: string;
  slug: string;
  courseId: string;
  assignmentId: string;
  student: string;
  instructor: string;
  otherStudent: string;
  repositoryId: string;
  githubRepoId: number;
  owner: string;
  name: string;
  submissionId: string;
}

export interface ScenarioOptions {
  quota?: number;
  triggers?: Record<string, boolean>;
  suite?: boolean;
  dueAt?: Date;
  latePolicy?: { per_day_percent: number; max_days: number; grace_minutes: number };
  weights?: { automated: number; rubric: number; process: number };
  /** Student's extended deadline. */
  extensionDueAt?: Date;
}

/** A published assignment with a grader suite, and one student with an active repository. */
export async function createScenario(db: Db, fixtures: Fixtures, opts: ScenarioOptions = {}): Promise<Scenario> {
  const student = await fixtures.user({ githubId: randomGithubId() });
  const instructor = await fixtures.user();
  const otherStudent = await fixtures.user();
  const inst = await fixtures.institution([
    { userId: student, role: "student" },
    { userId: instructor, role: "teacher" },
    { userId: otherStudent, role: "student" },
  ]);
  const installationId = randomGithubId();
  fixtures.installationIds.push(installationId);
  const owner = `org-${unique()}`;
  const gh = await db
    .insertInto("github_installations")
    .values({
      institution_id: inst.id,
      installation_id: installationId,
      account_id: 1,
      account_login: owner,
      account_type: "Organization",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const course = await db
    .insertInto("courses")
    .values({ institution_id: inst.id, code: "C1", name: "Course", term: "T", github_installation_id: gh.id })
    .returning("id")
    .executeTakeFirstOrThrow();
  await db
    .insertInto("course_memberships")
    .values([
      { institution_id: inst.id, course_id: course.id, user_id: student, role: "student" },
      { institution_id: inst.id, course_id: course.id, user_id: instructor, role: "instructor" },
      { institution_id: inst.id, course_id: course.id, user_id: otherStudent, role: "student" },
    ])
    .execute();
  const profile = await db
    .selectFrom("stack_profiles")
    .select("id")
    .where("key", "=", "mern-node20")
    .executeTakeFirstOrThrow();
  const suite = await db
    .selectFrom("grader_suites")
    .select("id")
    .where("key", "=", "todo-api")
    .where("institution_id", "is", null)
    .executeTakeFirstOrThrow();
  const assignment = await db
    .insertInto("assignments")
    .values({
      institution_id: inst.id,
      course_id: course.id,
      slug: "todo-api",
      title: "Todo",
      stack_profile_id: profile.id,
      template_repo: "t/t",
      due_at: opts.dueAt ?? new Date(Date.now() + 7 * 86_400_000),
      status: "published",
      published_at: new Date(),
      grader_suite_id: opts.suite === false ? null : suite.id,
      run_quota_per_day: opts.quota ?? 2,
      triggers: JSON.stringify(opts.triggers ?? { on_push: true, on_pull_request: true, manual: true }),
      ...(opts.latePolicy ? { late_policy: JSON.stringify(opts.latePolicy) } : {}),
      ...(opts.weights ? { weights: JSON.stringify(opts.weights) } : {}),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const name = `todo-api-${unique()}`;
  const githubRepoId = randomGithubId();
  const repo = await db
    .insertInto("repositories")
    .values({ institution_id: inst.id, github_installation_id: gh.id, owner, name, github_repo_id: githubRepoId })
    .returning("id")
    .executeTakeFirstOrThrow();
  const submission = await db
    .insertInto("submissions")
    .values({
      institution_id: inst.id,
      assignment_id: assignment.id,
      user_id: student,
      repository_id: repo.id,
      status: "active",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  if (opts.extensionDueAt) {
    await db
      .insertInto("assignment_extensions")
      .values({
        institution_id: inst.id,
        assignment_id: assignment.id,
        user_id: student,
        due_at: opts.extensionDueAt,
        reason: null,
        granted_by: instructor,
      })
      .execute();
  }
  return {
    institutionId: inst.id,
    slug: inst.slug,
    courseId: course.id,
    assignmentId: assignment.id,
    student,
    instructor,
    otherStudent,
    repositoryId: repo.id,
    githubRepoId,
    owner,
    name,
    submissionId: submission.id,
  };
}

/** A push event to the scenario's repository (default branch unless `ref` is given). */
export const pushEvent = (
  s: Scenario,
  after: string,
  opts: { ref?: string; pushedAt?: number; bot?: boolean } = {},
) => ({
  ref: opts.ref ?? "refs/heads/main",
  after,
  repository: {
    id: s.githubRepoId,
    full_name: `${s.owner}/${s.name}`,
    pushed_at: opts.pushedAt ?? Math.floor(Date.now() / 1000),
  },
  sender: opts.bot ? { id: 1, login: "hbe[bot]", type: "Bot" } : { id: 2, login: "ada", type: "User" },
  commits: [{ id: after, message: "Work", timestamp: new Date().toISOString(), distinct: true }],
});
