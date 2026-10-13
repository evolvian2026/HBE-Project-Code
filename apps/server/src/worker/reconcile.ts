import type { Db } from "@hbe/db";
import { GitHubError, type GitHubClient, type HookDelivery } from "@hbe/github";
import type { JobQueue } from "@hbe/queue";
import { handlePush, type ActivityDeps } from "./activity.ts";

/** Deliveries this recent are looked at (GitHub keeps them for 3 days). */
const REDELIVERY_WINDOW_MS = 6 * 3_600_000;
/** Attempts per delivery, the first included, before the platform stops asking. */
const MAX_ATTEMPTS = 3;
/** A redelivery asked for this recently may still be on its way. */
const REDELIVERY_GRACE_MS = 10 * 60_000;

const SHA = /^[0-9a-f]{40}$/;
const NO_COMMIT = /^0{40}$/;

/**
 * GitHub doesn't retry a webhook delivery that failed (the platform was down, or answered with an
 * error), so the platform asks for it again, a few times at most. Deliveries the platform stored
 * are left alone: their processing is retried from the stored copy.
 */
export async function redeliverFailed(
  deps: { db: Db; github: GitHubClient; log: ActivityDeps["log"] },
  now = new Date(),
): Promise<number> {
  const { db, github, log } = deps;
  const attempts = new Map<string, HookDelivery[]>();
  for (const d of await github.listDeliveries(new Date(now.getTime() - REDELIVERY_WINDOW_MS))) {
    attempts.set(d.guid, [...(attempts.get(d.guid) ?? []), d]);
  }
  const failed = [...attempts].filter(([, list]) => !list.some((d) => d.statusCode >= 200 && d.statusCode < 300));
  if (!failed.length) return 0;
  const stored = new Set(
    (
      await db
        .selectFrom("github_events")
        .select("delivery_id")
        .where(
          "delivery_id",
          "in",
          failed.map(([guid]) => guid),
        )
        .execute()
    ).map((e) => e.delivery_id),
  );

  let asked = 0;
  for (const [guid, list] of failed) {
    if (stored.has(guid)) continue;
    const newest = list.reduce((a, b) => (Date.parse(b.deliveredAt) > Date.parse(a.deliveredAt) ? b : a));
    if (newest.redelivery && now.getTime() - Date.parse(newest.deliveredAt) < REDELIVERY_GRACE_MS) continue;
    if (list.length >= MAX_ATTEMPTS) {
      log.warn(
        { guid, event: newest.event, attempts: list.length },
        "webhook delivery keeps failing; not asking again",
      );
      continue;
    }
    try {
      await github.redeliver(newest.id);
      asked++;
    } catch (err) {
      if (err instanceof GitHubError && !err.retryable) {
        log.warn({ guid, err: err.message }, "GitHub refused a redelivery");
        continue;
      }
      throw err;
    }
  }
  if (asked) log.info({ asked }, "asked GitHub to redeliver failed webhook deliveries");
  return asked;
}

/**
 * Pushes to the default branch that the platform never heard of (a lost webhook), from the
 * repository's event feed: recorded as if the push had just been delivered, with GitHub's time
 * of the push, which decides the graded commit. Read by ETag, so an unchanged feed costs
 * nothing. Returns how many pushes were recorded.
 */
export async function reconcileRepository(
  deps: ActivityDeps & { github: GitHubClient },
  repositoryId: string,
): Promise<number> {
  const { db, github, log } = deps;
  const repo = await db
    .selectFrom("repositories as r")
    .innerJoin("github_installations as g", "g.id", "r.github_installation_id")
    .select(["r.id", "r.owner", "r.name", "r.github_repo_id", "r.default_branch", "r.events_etag", "g.installation_id"])
    .where("r.id", "=", repositoryId)
    .executeTakeFirst();
  if (!repo?.github_repo_id) return 0;
  const gh = github.forInstallation(repo.installation_id);
  const feed = await gh.listRepoEvents(repo.owner, repo.name, repo.events_etag);
  if (feed.notModified) {
    await db.updateTable("repositories").set({ events_checked_at: new Date() }).where("id", "=", repo.id).execute();
    return 0;
  }

  const pushes = feed.events
    .filter((e) => e.type === "PushEvent" && e.payload.ref === `refs/heads/${repo.default_branch}`)
    .map((e) => ({ ...e, head: String(e.payload.head ?? ""), before: String(e.payload.before ?? "") }))
    .filter((e) => SHA.test(e.head))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const known = new Set(
    pushes.length
      ? (
          await db
            .selectFrom("branch_pushes")
            .select("sha")
            .where("repository_id", "=", repo.id)
            .where(
              "sha",
              "in",
              pushes.map((p) => p.head),
            )
            .execute()
        ).map((p) => p.sha)
      : [],
  );

  let recorded = 0;
  for (const p of pushes) {
    if (known.has(p.head)) continue;
    const base = SHA.test(p.before) && !NO_COMMIT.test(p.before) ? p.before : null;
    const commits = await gh.listPushedCommits(repo.owner, repo.name, base, p.head);
    await handlePush(deps, {
      ref: `refs/heads/${repo.default_branch}`,
      after: p.head,
      repository: {
        id: repo.github_repo_id,
        full_name: `${repo.owner}/${repo.name}`,
        pushed_at: Math.floor(Date.parse(p.createdAt) / 1000),
      },
      sender: p.actor
        ? { id: p.actor.id, login: p.actor.login, type: /\[bot\]$/.test(p.actor.login) ? "Bot" : "User" }
        : undefined,
      commits: commits.map((c) => ({
        id: c.sha,
        message: c.message,
        timestamp: c.timestamp,
        distinct: true,
        author: {
          ...(c.authorLogin ? { username: c.authorLogin } : {}),
          ...(c.authorEmail ? { email: c.authorEmail } : {}),
          ...(c.authorName ? { name: c.authorName } : {}),
        },
      })),
    });
    known.add(p.head);
    recorded++;
  }
  await db
    .updateTable("repositories")
    .set({ events_etag: feed.etag, events_checked_at: new Date() })
    .where("id", "=", repo.id)
    .execute();
  if (recorded) log.warn({ repositoryId, recorded }, "recorded pushes whose webhooks never arrived");
  return recorded;
}

/** Queues reconciliation for every repository still taking work (its submission isn't finalized). */
export async function queueReconciliation(deps: { db: Db; queue: JobQueue }): Promise<number> {
  const repos = await deps.db
    .selectFrom("repositories as r")
    .innerJoin("submissions as s", "s.repository_id", "r.id")
    .innerJoin("assignments as a", "a.id", "s.assignment_id")
    .select("r.id")
    .distinct()
    .where("r.github_repo_id", "is not", null)
    .where("s.finalized_at", "is", null)
    .where("s.status", "=", "active")
    .where("a.status", "=", "published")
    .execute();
  for (const { id } of repos) {
    await deps.queue.send("reconcile-repo", { repositoryId: id }, { singletonKey: `reconcile-${id}` });
  }
  return repos.length;
}
