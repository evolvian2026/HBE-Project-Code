import { computeProcessScore, effectiveLines, linkedIssues, type ProcessPolicy } from "@hbe/core";
import type { Db } from "@hbe/db";
import {
  GitHubError,
  type GitHubClient,
  type IssuesEvent,
  type PullRequestEvent,
  type PullRequestReviewEvent,
  type PushEvent,
} from "@hbe/github";
import type { JobQueue } from "@hbe/queue";
import type { Settings } from "@hbe/settings";
import type { FastifyBaseLogger } from "fastify";
import { queueRun } from "../evaluation.ts";
import { leadSubmissionId } from "../teams.ts";

export interface ActivityDeps {
  db: Db;
  queue: JobQueue;
  settings: Settings;
  log: FastifyBaseLogger;
}

/** The tracked repository for a GitHub repository id, or null if it is not a student repository. */
async function trackedRepository(db: Db, githubRepoId: number) {
  return (
    (await db
      .selectFrom("repositories")
      .select(["id", "institution_id", "owner", "name", "default_branch"])
      .where("github_repo_id", "=", githubRepoId)
      .executeTakeFirst()) ?? null
  );
}

async function profileIdForGithubUser(db: Db, githubUserId: number | null | undefined): Promise<string | null> {
  if (!githubUserId) return null;
  const row = await db
    .selectFrom("profiles")
    .select("id")
    .where("github_user_id", "=", githubUserId)
    .executeTakeFirst();
  return row?.id ?? null;
}

/** Queues a process-score refresh for every submission using this repository. */
export async function refreshProcessScores(
  { db, queue }: Pick<ActivityDeps, "db" | "queue">,
  repositoryId: string,
): Promise<void> {
  const subs = await db.selectFrom("submissions").select("id").where("repository_id", "=", repositoryId).execute();
  for (const { id } of subs) await queue.send("process-score", { submissionId: id }, { singletonKey: `process-${id}` });
}

/**
 * Queues automatic test runs for the submissions using a repository, when their assignment
 * is open, has a grader suite, and runs on this kind of event.
 */
export async function queueAutomaticRuns(
  deps: Pick<ActivityDeps, "db" | "queue" | "settings">,
  repositoryId: string,
  trigger: "push" | "pull_request",
  sha: string,
): Promise<number> {
  const subs = await deps.db
    .selectFrom("submissions as s")
    .innerJoin("assignments as a", "a.id", "s.assignment_id")
    .select(["s.id", "a.triggers"])
    .where("s.repository_id", "=", repositoryId)
    .where("s.status", "=", "active")
    .where("a.status", "=", "published")
    .where("a.grader_suite_id", "is not", null)
    .execute();
  let queued = 0;
  // A team shares its repository: one run per push for the whole team, on its lead submission.
  const done = new Set<string>();
  for (const s of subs) {
    const triggers = s.triggers as { on_push?: boolean; on_pull_request?: boolean };
    if (!(trigger === "push" ? triggers.on_push : triggers.on_pull_request)) continue;
    const lead = await leadSubmissionId(deps.db, s.id);
    if (done.has(lead)) continue;
    done.add(lead);
    await queueRun(deps, { submissionId: lead, sha, trigger, requestedBy: null });
    queued++;
  }
  return queued;
}

export async function handlePush(deps: ActivityDeps, event: PushEvent): Promise<void> {
  if (!event.ref.startsWith("refs/heads/")) return; // tags
  const repo = await trackedRepository(deps.db, event.repository.id);
  if (!repo) return;
  const branch = event.ref.slice("refs/heads/".length);
  const commits = event.commits.filter((c) => c.distinct);

  if (commits.length) {
    await deps.db
      .insertInto("commits")
      .values(
        commits.map((c) => ({
          institution_id: repo.institution_id,
          repository_id: repo.id,
          sha: c.id,
          branch,
          message: c.message.slice(0, 1000),
          authored_at: new Date(c.timestamp),
          author_login: c.author?.username ?? null,
        })),
      )
      .onConflict((oc) => oc.columns(["repository_id", "sha"]).doNothing())
      .execute();
    await deps.queue.send("commit-details", { repositoryId: repo.id });
  }

  // A new head on the default branch (also a fast-forward with no new commits) gets tested.
  if (branch !== repo.default_branch || event.deleted || !event.after || !/^[0-9a-f]{40}$/.test(event.after)) return;
  const pushedAt = event.repository.pushed_at ? new Date(event.repository.pushed_at * 1000) : new Date();
  // The push history decides which commit is graded at the deadline.
  await deps.db
    .insertInto("branch_pushes")
    .values({
      institution_id: repo.institution_id,
      repository_id: repo.id,
      sha: event.after,
      pushed_at: pushedAt,
      pusher_github_id: event.sender?.id ?? null,
      by_bot: event.sender?.type === "Bot",
      forced: event.forced ?? false,
    })
    .onConflict((oc) => oc.columns(["repository_id", "pushed_at", "sha"]).doNothing())
    .execute();
  const moved = await deps.db
    .updateTable("repositories")
    .set({ head_sha: event.after, head_pushed_at: pushedAt })
    .where("id", "=", repo.id)
    .where((eb) => eb.or([eb("head_pushed_at", "is", null), eb("head_pushed_at", "<=", pushedAt)]))
    .executeTakeFirst();
  if (moved.numUpdatedRows === 0n) return; // an older delivery arriving late
  await queueAutomaticRuns(deps, repo.id, "push", event.after);
}

export async function handlePullRequest(deps: ActivityDeps, event: PullRequestEvent): Promise<void> {
  const { db } = deps;
  const repo = await trackedRepository(db, event.repository.id);
  if (!repo) return;
  const pr = event.pull_request;
  const state = pr.merged_at ? "merged" : pr.state;
  await db
    .insertInto("pull_requests")
    .values({
      institution_id: repo.institution_id,
      repository_id: repo.id,
      number: pr.number,
      github_id: pr.id,
      author_github_id: pr.user.id,
      author_profile_id: await profileIdForGithubUser(db, pr.user.id),
      title: pr.title.slice(0, 500),
      body_length: (pr.body ?? "").trim().length,
      linked_issues: linkedIssues(pr.body),
      state,
      opened_at: new Date(pr.created_at),
      closed_at: pr.closed_at ? new Date(pr.closed_at) : null,
      merged_at: pr.merged_at ? new Date(pr.merged_at) : null,
    })
    .onConflict((oc) =>
      oc.columns(["repository_id", "number"]).doUpdateSet((eb) => ({
        title: eb.ref("excluded.title"),
        body_length: eb.ref("excluded.body_length"),
        linked_issues: eb.ref("excluded.linked_issues"),
        state: eb.ref("excluded.state"),
        closed_at: eb.ref("excluded.closed_at"),
        merged_at: eb.ref("excluded.merged_at"),
        updated_at: new Date(),
      })),
    )
    .execute();
  await refreshProcessScores(deps, repo.id);

  const sha = pr.head?.sha;
  if (
    ["opened", "reopened", "synchronize"].includes(event.action) &&
    pr.state === "open" &&
    sha &&
    /^[0-9a-f]{40}$/.test(sha)
  ) {
    await queueAutomaticRuns(deps, repo.id, "pull_request", sha);
  }
}

export async function handlePullRequestReview(
  { db, ...deps }: ActivityDeps,
  event: PullRequestReviewEvent,
): Promise<void> {
  if (event.action !== "submitted") return;
  const repo = await trackedRepository(db, event.repository.id);
  if (!repo) return;
  const review = event.review;
  await db
    .insertInto("pr_reviews")
    .values({
      institution_id: repo.institution_id,
      repository_id: repo.id,
      pr_number: event.pull_request.number,
      github_review_id: review.id,
      reviewer_github_id: review.user?.id ?? null,
      reviewer_profile_id: await profileIdForGithubUser(db, review.user?.id),
      state: review.state.toLowerCase(),
      submitted_at: review.submitted_at ? new Date(review.submitted_at) : new Date(),
    })
    .onConflict((oc) => oc.column("github_review_id").doNothing())
    .execute();
  await db
    .updateTable("pull_requests")
    .set((eb) => ({
      review_count: eb
        .selectFrom("pr_reviews")
        .select((e) => e.fn.countAll<number>().as("n"))
        .where("pr_reviews.repository_id", "=", repo.id)
        .where("pr_reviews.pr_number", "=", event.pull_request.number),
    }))
    .where("repository_id", "=", repo.id)
    .where("number", "=", event.pull_request.number)
    .execute();
  await refreshProcessScores({ db, queue: deps.queue }, repo.id);
}

export async function handleIssue({ db, ...deps }: ActivityDeps, event: IssuesEvent): Promise<void> {
  const repo = await trackedRepository(db, event.repository.id);
  if (!repo) return;
  const issue = event.issue;
  if (event.action === "deleted") {
    await db.deleteFrom("issues").where("repository_id", "=", repo.id).where("number", "=", issue.number).execute();
  } else {
    await db
      .insertInto("issues")
      .values({
        institution_id: repo.institution_id,
        repository_id: repo.id,
        number: issue.number,
        github_id: issue.id,
        author_github_id: issue.user.id,
        author_profile_id: await profileIdForGithubUser(db, issue.user.id),
        title: issue.title.slice(0, 500),
        state: issue.state,
        opened_at: new Date(issue.created_at),
        closed_at: issue.closed_at ? new Date(issue.closed_at) : null,
      })
      .onConflict((oc) =>
        oc.columns(["repository_id", "number"]).doUpdateSet((eb) => ({
          title: eb.ref("excluded.title"),
          state: eb.ref("excluded.state"),
          closed_at: eb.ref("excluded.closed_at"),
          updated_at: new Date(),
        })),
      )
      .execute();
  }
  await refreshProcessScores({ db, queue: deps.queue }, repo.id);
}

/**
 * Fetches commit details from GitHub: the matched author (by immutable user id), parents,
 * and per-file changes, which give the commit's effective size under the stack profile's
 * ignore_paths. Missing commits (force-pushed away) are marked unavailable.
 */
export async function fetchCommitDetails(
  deps: ActivityDeps & { github: GitHubClient },
  repositoryId: string,
): Promise<number> {
  const { db, github } = deps;
  const repo = await db
    .selectFrom("repositories as r")
    .innerJoin("github_installations as g", "g.id", "r.github_installation_id")
    .select(["r.id", "r.owner", "r.name", "g.installation_id"])
    .where("r.id", "=", repositoryId)
    .executeTakeFirst();
  if (!repo) return 0;
  const profile = await db
    .selectFrom("submissions as s")
    .innerJoin("assignments as a", "a.id", "s.assignment_id")
    .innerJoin("stack_profiles as p", "p.id", "a.stack_profile_id")
    .select("p.definition")
    .where("s.repository_id", "=", repositoryId)
    .executeTakeFirst();
  const ignorePaths = ((profile?.definition as { ignore_paths?: string[] } | undefined)?.ignore_paths ?? []).filter(
    (p): p is string => typeof p === "string",
  );

  const pending = await db
    .selectFrom("commits")
    .select(["id", "sha"])
    .where("repository_id", "=", repositoryId)
    .where("details_status", "=", "pending")
    .orderBy("authored_at")
    .limit(50)
    .execute();
  const gh = github.forInstallation(repo.installation_id);
  for (const c of pending) {
    try {
      const d = await gh.getCommit(repo.owner, repo.name, c.sha);
      await db
        .updateTable("commits")
        .set({
          details_status: "done",
          author_github_id: d.authorId,
          author_login: d.authorLogin,
          author_profile_id: await profileIdForGithubUser(db, d.authorId),
          is_bot: d.authorIsBot,
          parent_count: d.parentCount,
          additions: d.additions,
          deletions: d.deletions,
          files_changed: d.files.length,
          effective_lines: effectiveLines(d.files, ignorePaths),
        })
        .where("id", "=", c.id)
        .execute();
    } catch (err) {
      if (err instanceof GitHubError && !err.retryable) {
        await db.updateTable("commits").set({ details_status: "unavailable" }).where("id", "=", c.id).execute();
      } else {
        throw err;
      }
    }
  }
  if (pending.length) await refreshProcessScores(deps, repositoryId);
  if (pending.length === 50) await deps.queue.send("commit-details", { repositoryId }); // more to do
  return pending.length;
}

/**
 * Recomputes and stores a submission's process score, unless it is already frozen.
 * `final` freezes it (at the deadline): later activity no longer changes it.
 */
export async function computeSubmissionProcess(
  { db, log }: Pick<ActivityDeps, "db" | "log">,
  submissionId: string,
  { final = false }: { final?: boolean } = {},
): Promise<number | null> {
  const s = await db
    .selectFrom("submissions as s")
    .innerJoin("assignments as a", "a.id", "s.assignment_id")
    .innerJoin("courses as c", "c.id", "a.course_id")
    .leftJoin("assignment_extensions as x", (j) =>
      j.onRef("x.assignment_id", "=", "a.id").onRef("x.user_id", "=", "s.user_id"),
    )
    .leftJoin("process_snapshots as ps", "ps.submission_id", "s.id")
    .select([
      "s.id",
      "s.institution_id",
      "s.user_id",
      "s.repository_id",
      "s.team_id",
      "s.assignment_id",
      "a.process_policy",
      "a.due_at",
      "x.due_at as extended_due_at",
      "c.timezone",
      "ps.is_final",
    ])
    .where("s.id", "=", submissionId)
    .executeTakeFirst();
  if (!s || !s.repository_id || s.is_final) return null;

  const [commits, prs, issues] = await Promise.all([
    db.selectFrom("commits").selectAll().where("repository_id", "=", s.repository_id).execute(),
    db.selectFrom("pull_requests").selectAll().where("repository_id", "=", s.repository_id).execute(),
    db.selectFrom("issues").selectAll().where("repository_id", "=", s.repository_id).execute(),
  ]);
  // Team assignments: the member's own work counts; teammates' commits are theirs, not "unattributed".
  const teammates = new Set(
    s.team_id
      ? (
          await db
            .selectFrom("submissions")
            .select("user_id")
            .where("assignment_id", "=", s.assignment_id)
            .where("team_id", "=", s.team_id)
            .where("user_id", "!=", s.user_id)
            .execute()
        ).map((m) => m.user_id)
      : [],
  );
  const policy = s.process_policy as unknown as ProcessPolicy;
  const result = computeProcessScore({
    policy,
    deadline: new Date(s.extended_due_at ?? s.due_at),
    timeZone: s.timezone,
    team: Boolean(s.team_id),
    // Commits GitHub no longer has (force-pushed away) are left out entirely.
    commits: commits
      .filter((c) => c.details_status !== "unavailable")
      .map((c) => ({
        sha: c.sha,
        authoredAt: new Date(c.authored_at),
        byStudent: c.author_profile_id === s.user_id,
        byTeammate: c.author_profile_id !== null && teammates.has(c.author_profile_id),
        isBot: c.is_bot,
        parentCount: c.parent_count,
        effectiveLines: c.details_status === "done" ? c.effective_lines : null,
      })),
    pullRequests: prs.map((p) => ({
      byStudent: p.author_profile_id === s.user_id,
      bodyLength: p.body_length,
      linkedIssues: p.linked_issues,
      mergedAt: p.merged_at ? new Date(p.merged_at) : null,
    })),
    issues: issues.map((i) => ({
      byStudent: i.author_profile_id === s.user_id,
      closedAt: i.closed_at ? new Date(i.closed_at) : null,
    })),
  });

  const breakdown = JSON.stringify(result);
  await db
    .insertInto("process_snapshots")
    .values({
      institution_id: s.institution_id,
      submission_id: s.id,
      score: String(result.score),
      breakdown,
      policy: JSON.stringify(policy),
      is_final: final,
    })
    .onConflict((oc) =>
      oc
        .column("submission_id")
        .doUpdateSet({
          score: String(result.score),
          breakdown,
          policy: JSON.stringify(policy),
          computed_at: new Date(),
          is_final: final,
        })
        .where("process_snapshots.is_final", "=", false),
    )
    .execute();
  log.debug({ submissionId, score: result.score }, "process score updated");
  return result.score;
}
