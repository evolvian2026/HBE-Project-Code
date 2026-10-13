import { randomUUID } from "node:crypto";
import { FakeGitHub, GitHubError, type HookDelivery } from "@hbe/github";
import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { finalizeDueSubmissions } from "../src/worker/deadlines.ts";
import { queueReconciliation, reconcileRepository, redeliverFailed } from "../src/worker/reconcile.ts";
import { FakeQueue, Fixtures, testDb, testSettings } from "./helpers.ts";
import { createScenario, sha, type Scenario } from "./scenario.ts";

const db = testDb();
const fixtures = new Fixtures(db);
const settings = testSettings();
const log = Fastify({ logger: false }).log;

afterAll(async () => {
  await fixtures.cleanup();
  await db.destroy();
});

const HOUR = 3_600_000;

/** A push to `main` in the repository's GitHub event feed, and the commits it added. */
function feedPush(github: FakeGitHub, s: Scenario, at: Date, opts: { before?: string; etag?: string } = {}) {
  const head = sha();
  const before = opts.before ?? "0".repeat(40);
  const key = `${s.owner}/${s.name}`.toLowerCase();
  const feed = github.repoEvents.get(key) ?? { etag: "", events: [] };
  feed.etag = opts.etag ?? `"${randomUUID()}"`;
  feed.events.unshift({
    id: String(Date.now() + feed.events.length),
    type: "PushEvent",
    createdAt: at.toISOString(),
    actor: { id: 77, login: "ada" },
    payload: { ref: "refs/heads/main", head, before },
  });
  github.repoEvents.set(key, feed);
  github.pushedCommits.set(`${key}:${before === "0".repeat(40) ? "" : before}..${head}`, [
    {
      sha: head,
      message: "Add routes",
      timestamp: new Date(at.getTime() - 60_000).toISOString(),
      authorName: "Ada",
      authorEmail: "Ada@Laptop.test",
      authorLogin: "ada",
    },
  ]);
  return head;
}

describe("redelivering failed webhooks", () => {
  it("asks again for deliveries that failed and were never stored, a few times at most", async () => {
    const github = new FakeGitHub();
    const now = new Date();
    const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
    let id = 1;
    const attempt = (guid: string, minutes: number, statusCode: number, redelivery = false): HookDelivery => ({
      id: id++,
      guid,
      deliveredAt: ago(minutes),
      statusCode,
      redelivery,
      event: "push",
    });
    const g = Object.fromEntries(["lost", "recovered", "stored", "hopeless", "inFlight"].map((k) => [k, randomUUID()]));
    const stored = g.stored!;
    fixtures.deliveryIds.push(stored);
    await db.insertInto("github_events").values({ delivery_id: stored, event: "push", payload: "{}" }).execute();
    github.deliveries.push(
      attempt(g.inFlight!, 2, 502, true),
      attempt(g.inFlight!, 30, 502),
      attempt(g.recovered!, 20, 202, true),
      attempt(g.recovered!, 40, 0),
      attempt(g.stored!, 50, 500),
      attempt(g.hopeless!, 60, 502, true),
      attempt(g.hopeless!, 90, 502, true),
      attempt(g.hopeless!, 120, 502),
      attempt(g.lost!, 45, 0),
    );
    const lost = github.deliveries.find((d) => d.guid === g.lost)!;

    expect(await redeliverFailed({ db, github, log }, now)).toBe(1);
    expect(github.redelivered).toEqual([lost.id]);
  });
});

describe("reconciling pushes with GitHub", () => {
  it("records pushes whose webhooks never arrived, with GitHub's time of the push", async () => {
    const s = await createScenario(db, fixtures);
    const github = new FakeGitHub();
    const queue = new FakeQueue();
    const deps = { db, queue, settings, log, github };
    const pushedAt = new Date(Date.now() - 2 * HOUR);
    const head = feedPush(github, s, pushedAt);

    expect(await reconcileRepository(deps, s.repositoryId)).toBe(1);
    const push = await db
      .selectFrom("branch_pushes")
      .selectAll()
      .where("repository_id", "=", s.repositoryId)
      .executeTakeFirstOrThrow();
    expect(push).toMatchObject({ sha: head, pusher_github_id: 77, by_bot: false });
    expect(new Date(push.pushed_at).getTime()).toBe(Math.floor(pushedAt.getTime() / 1000) * 1000);
    expect(
      await db.selectFrom("commits").selectAll().where("repository_id", "=", s.repositoryId).executeTakeFirstOrThrow(),
    ).toMatchObject({ sha: head, message: "Add routes", author_email: "ada@laptop.test", author_login: "ada" });
    const repo = await db
      .selectFrom("repositories")
      .selectAll()
      .where("id", "=", s.repositoryId)
      .executeTakeFirstOrThrow();
    expect(repo).toMatchObject({
      head_sha: head,
      events_etag: github.repoEvents.get(`${s.owner}/${s.name}`.toLowerCase())!.etag,
    });
    // The new head is tested, as a push would be.
    expect(queue.sent).toContainEqual(expect.objectContaining({ name: "dispatch-run" }));

    // Unchanged feed: GitHub answers 304 and nothing happens.
    github.calls.length = 0;
    expect(await reconcileRepository(deps, s.repositoryId)).toBe(0);
    expect(github.calls).toEqual([`listRepoEvents ${s.owner}/${s.name}`]);

    // A feed with a push the platform already knows (from its webhook) changes nothing.
    await db
      .updateTable("branch_pushes")
      .set({ pushed_at: new Date(pushedAt.getTime() + 1000) })
      .where("repository_id", "=", s.repositoryId)
      .execute();
    github.repoEvents.get(`${s.owner}/${s.name}`.toLowerCase())!.etag = '"changed"';
    expect(await reconcileRepository(deps, s.repositoryId)).toBe(0);
    expect(
      await db.selectFrom("branch_pushes").select("id").where("repository_id", "=", s.repositoryId).execute(),
    ).toHaveLength(1);

    // Every repository still taking work is reconciled.
    queue.sent.length = 0;
    expect(await queueReconciliation({ db, queue })).toBeGreaterThanOrEqual(1);
    expect(queue.sent).toContainEqual({
      name: "reconcile-repo",
      data: { repositoryId: s.repositoryId },
      options: { singletonKey: `reconcile-${s.repositoryId}` },
    });
  });

  it("happens just before the cutoff, so a push whose webhook was lost is still graded", async () => {
    const dueAt = new Date(Date.now() - 2 * HOUR);
    const s = await createScenario(db, fixtures, {
      dueAt,
      latePolicy: { per_day_percent: 10, max_days: 0, grace_minutes: 15 },
    });
    const github = new FakeGitHub();
    const onTime = feedPush(github, s, new Date(dueAt.getTime() - HOUR));
    feedPush(github, s, new Date(dueAt.getTime() + HOUR), { before: onTime }); // too late to count
    await finalizeDueSubmissions({ db, queue: new FakeQueue(), settings, log, github });
    expect(
      await db
        .selectFrom("submissions")
        .select(["final_sha", "status"])
        .where("id", "=", s.submissionId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ final_sha: onTime, status: "submitted" });
  });

  it("doesn't hold up the cutoff when GitHub can't be reached", async () => {
    const s = await createScenario(db, fixtures, {
      dueAt: new Date(Date.now() - 2 * HOUR),
      latePolicy: { per_day_percent: 10, max_days: 0, grace_minutes: 15 },
    });
    const github = new FakeGitHub();
    github.failures.push(new GitHubError(0, "GitHub unreachable", true));
    await finalizeDueSubmissions({ db, queue: new FakeQueue(), settings, log, github });
    expect(
      await db
        .selectFrom("submissions")
        .select(["final_sha", "status"])
        .where("id", "=", s.submissionId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ final_sha: null, status: "missing" });
  });
});
