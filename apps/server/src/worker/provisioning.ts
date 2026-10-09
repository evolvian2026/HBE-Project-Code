import { repositoryName, teamRepositoryName } from "@hbe/core";
import { sql, type Db } from "@hbe/db";
import { GitHubError, type GitHubClient } from "@hbe/github";
import type { JobQueue } from "@hbe/queue";
import type { FastifyBaseLogger } from "fastify";

export interface ProvisionDeps {
  db: Db;
  github: GitHubClient;
  queue: JobQueue;
  log: FastifyBaseLogger;
}

export type ProvisionOutcome = "active" | "failed" | "waiting_for_github" | "waiting_for_team" | "skipped";

const STALE_SECONDS = 60;
const MAX_ATTEMPTS = 10;

/**
 * Creates the student's repository (or, on a team assignment, their team's) from the
 * assignment's template in the course's GitHub organisation and gives them push access.
 * Idempotent: an existing repository (created by a teammate's job, or by an attempt that
 * crashed before recording it) is adopted, not recreated. Permanent errors mark the
 * submission failed; transient ones throw so pg-boss retries.
 */
export async function provisionSubmission(deps: ProvisionDeps, submissionId: string): Promise<ProvisionOutcome> {
  const { db, github, log } = deps;
  const s = await db
    .selectFrom("submissions as s")
    .innerJoin("assignments as a", "a.id", "s.assignment_id")
    .innerJoin("courses as c", "c.id", "a.course_id")
    .innerJoin("profiles as p", "p.id", "s.user_id")
    .leftJoin("github_installations as g", "g.id", "c.github_installation_id")
    .leftJoin("teams as t", "t.id", "s.team_id")
    .select([
      "s.id",
      "s.institution_id",
      "s.status",
      "s.repository_id",
      "a.slug as assignment_slug",
      "a.title as assignment_title",
      "a.template_repo",
      "a.mode",
      "t.id as team_id",
      "t.slug as team_slug",
      "t.name as team_name",
      "p.github_login",
      "p.full_name",
      "g.id as installation_row_id",
      "g.installation_id",
      "g.account_login as org",
      "g.suspended_at",
      "g.deleted_at",
    ])
    .where("s.id", "=", submissionId)
    .executeTakeFirst();
  if (!s || s.status !== "provisioning") return "skipped";

  const fail = async (detail: string): Promise<ProvisionOutcome> => {
    await db
      .updateTable("submissions")
      .set({ status: "provisioning_failed", status_detail: detail.slice(0, 500) })
      .where("id", "=", s.id)
      .execute();
    log.warn({ submissionId, detail }, "repository provisioning failed");
    return "failed";
  };

  if (s.mode === "team" && !s.team_id) {
    await db
      .updateTable("submissions")
      .set({ status: "waiting_for_team", status_detail: null })
      .where("id", "=", s.id)
      .execute();
    return "waiting_for_team";
  }
  if (!s.github_login) {
    await db
      .updateTable("submissions")
      .set({ status: "waiting_for_github", status_detail: null })
      .where("id", "=", s.id)
      .execute();
    return "waiting_for_github";
  }
  if (!s.installation_id || !s.org || s.deleted_at)
    return fail("The course is not connected to a GitHub organisation.");
  if (s.suspended_at) return fail("The GitHub App installation for this course is suspended.");
  const [templateOwner, templateRepo] = (s.template_repo ?? "").split("/");
  if (!templateOwner || !templateRepo) return fail("The assignment has no template repository.");

  await db
    .updateTable("submissions")
    .set((eb) => ({ provisioning_attempts: eb("provisioning_attempts", "+", 1) }))
    .where("id", "=", s.id)
    .execute();

  const gh = github.forInstallation(s.installation_id);
  const team = s.team_id ? { id: s.team_id, slug: s.team_slug!, name: s.team_name! } : null;
  const name = team
    ? teamRepositoryName(s.assignment_slug, team.slug, team.id)
    : repositoryName(s.assignment_slug, s.github_login);
  try {
    const create = () =>
      gh.createRepoFromTemplate({
        templateOwner,
        templateRepo,
        owner: s.org!,
        name,
        description: `${s.assignment_title} — ${team ? `team ${team.name}` : (s.full_name ?? s.github_login)}`,
      });
    // Teammates' jobs may race to create the team's repository: the loser adopts it.
    const repo =
      (await gh.getRepo(s.org, name)) ??
      (await create().catch(async (err: unknown) => {
        const existing = err instanceof GitHubError && err.status === 422 ? await gh.getRepo(s.org!, name) : null;
        if (existing) return existing;
        throw err;
      }));

    const repoRow = await db
      .insertInto("repositories")
      .values({
        institution_id: s.institution_id,
        github_installation_id: s.installation_row_id!,
        owner: repo.owner,
        name: repo.name,
        github_repo_id: repo.id,
        default_branch: repo.defaultBranch,
        private: repo.private,
      })
      .onConflict((oc) =>
        oc.columns(["owner", "name"]).doUpdateSet((eb) => ({
          github_repo_id: eb.ref("excluded.github_repo_id"),
          default_branch: eb.ref("excluded.default_branch"),
          private: eb.ref("excluded.private"),
        })),
      )
      .returning("id")
      .executeTakeFirstOrThrow();

    await gh.addCollaborator(repo.owner, repo.name, s.github_login, "push");

    await db
      .updateTable("submissions")
      .set({ status: "active", status_detail: null, repository_id: repoRow.id })
      .where("id", "=", s.id)
      .execute();
    log.info({ submissionId, repo: `${repo.owner}/${repo.name}` }, "repository provisioned");
    return "active";
  } catch (err) {
    if (err instanceof GitHubError && !err.retryable) return fail(err.message);
    await db
      .updateTable("submissions")
      .set({ status_detail: `Retrying: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500) })
      .where("id", "=", s.id)
      .execute();
    throw err;
  }
}

/** Re-enqueues submissions that have sat in provisioning (enqueue lost, worker restarted). */
export async function sweepProvisioning(
  { db, queue, log }: Pick<ProvisionDeps, "db" | "queue" | "log">,
  { staleSeconds = STALE_SECONDS }: { staleSeconds?: number } = {},
): Promise<number> {
  const stale = await db
    .selectFrom("submissions")
    .select("id")
    .where("status", "=", "provisioning")
    .where("provisioning_attempts", "<", MAX_ATTEMPTS)
    .where("updated_at", "<", sql<Date>`now() - make_interval(secs => ${staleSeconds})`)
    .limit(200)
    .execute();
  for (const { id } of stale)
    await queue.send("provision-submission", { submissionId: id }, { singletonKey: `provision-${id}` });
  if (stale.length) log.info({ count: stale.length }, "re-enqueued stale provisioning");
  return stale.length;
}
