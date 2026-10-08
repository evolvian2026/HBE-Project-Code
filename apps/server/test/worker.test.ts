import { randomUUID } from "node:crypto";
import { sql, type Json } from "@hbe/db";
import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { processGithubEvent, sweepUnprocessedEvents, type WorkerDeps } from "../src/worker/github-events.ts";
import { FakeQueue, Fixtures, randomGithubId, testDb, testSettings } from "./helpers.ts";

const db = testDb();
const fixtures = new Fixtures(db);
const queue = new FakeQueue();
const deps: WorkerDeps = { db, queue, settings: testSettings(), log: Fastify({ logger: false }).log };

afterAll(async () => {
  await fixtures.cleanup();
  await db.destroy();
});

async function storeEvent(event: string, payload: Record<string, unknown>, receivedAt?: Date): Promise<number> {
  const deliveryId = randomUUID();
  fixtures.deliveryIds.push(deliveryId);
  const installation = payload.installation as { id?: number } | undefined;
  const row = await db
    .insertInto("github_events")
    .values({
      delivery_id: deliveryId,
      event,
      action: (payload.action as string) ?? null,
      installation_id: installation?.id ?? null,
      institution_id: null,
      repository_full_name: null,
      sender_id: (payload.sender as { id?: number } | undefined)?.id ?? null,
      payload: JSON.stringify(payload) as Json,
      ...(receivedAt ? { received_at: receivedAt } : {}),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

function installationPayload(action: string, installationId: number, senderId: number) {
  return {
    action,
    installation: {
      id: installationId,
      account: { id: installationId + 1, login: `org-${installationId}`, type: "Organization" },
      repository_selection: "all",
      permissions: { contents: "read", metadata: "read" },
      events: ["push", "pull_request"],
    },
    sender: { id: senderId, login: `user-${senderId}` },
  };
}

describe("installation events", () => {
  it("links a new installation to the institution whose admin requested it", async () => {
    const adminGithubId = randomGithubId();
    const admin = await fixtures.user({ githubId: adminGithubId });
    const inst = await fixtures.institution([{ userId: admin, role: "admin" }]);
    await db
      .insertInto("github_link_requests")
      .values({ institution_id: inst.id, requested_by: admin, github_user_id: adminGithubId })
      .execute();

    const installationId = randomGithubId();
    fixtures.installationIds.push(installationId);
    // A delivery that arrived before the link exists gets backfilled with the institution.
    const earlier = await storeEvent("installation_repositories", {
      action: "added",
      installation: { id: installationId },
    });
    const eventId = await storeEvent("installation", installationPayload("created", installationId, adminGithubId));

    await processGithubEvent(deps, eventId);

    const installation = await db
      .selectFrom("github_installations")
      .selectAll()
      .where("installation_id", "=", installationId)
      .executeTakeFirstOrThrow();
    expect(installation).toMatchObject({
      institution_id: inst.id,
      linked_by: admin,
      account_login: `org-${installationId}`,
    });
    expect(installation.events).toEqual(["push", "pull_request"]);

    const request = await db
      .selectFrom("github_link_requests")
      .selectAll()
      .where("institution_id", "=", inst.id)
      .executeTakeFirstOrThrow();
    expect(request.installation_id).toBe(installationId);
    expect(request.completed_at).not.toBeNull();

    const events = await db
      .selectFrom("github_events")
      .select(["id", "institution_id", "processed_at"])
      .where("id", "in", [earlier, eventId])
      .execute();
    expect(events.every((e) => e.institution_id === inst.id)).toBe(true);
    expect(events.find((e) => e.id === eventId)?.processed_at).not.toBeNull();

    const audit = await db
      .selectFrom("audit_logs")
      .select("actor_id")
      .where("entity", "=", "github_installations")
      .where("institution_id", "=", inst.id)
      .executeTakeFirst();
    expect(audit?.actor_id).toBe(admin);
  });

  it("does not link when the installer has no pending request", async () => {
    const installationId = randomGithubId();
    fixtures.installationIds.push(installationId);
    const eventId = await storeEvent("installation", installationPayload("created", installationId, randomGithubId()));
    await processGithubEvent(deps, eventId);
    const installation = await db
      .selectFrom("github_installations")
      .select("institution_id")
      .where("installation_id", "=", installationId)
      .executeTakeFirstOrThrow();
    expect(installation.institution_id).toBeNull();
  });

  it("does not relink an installation that already belongs to an institution", async () => {
    const githubId = randomGithubId();
    const admin = await fixtures.user({ githubId });
    const owner = await fixtures.institution();
    const other = await fixtures.institution([{ userId: admin, role: "admin" }]);
    const installationId = randomGithubId();
    fixtures.installationIds.push(installationId);
    await db
      .insertInto("github_installations")
      .values({
        institution_id: owner.id,
        installation_id: installationId,
        account_id: 1,
        account_login: "x",
        account_type: "Organization",
      })
      .execute();
    await db
      .insertInto("github_link_requests")
      .values({ institution_id: other.id, requested_by: admin, github_user_id: githubId })
      .execute();

    await processGithubEvent(
      deps,
      await storeEvent("installation", installationPayload("created", installationId, githubId)),
    );
    const installation = await db
      .selectFrom("github_installations")
      .select("institution_id")
      .where("installation_id", "=", installationId)
      .executeTakeFirstOrThrow();
    expect(installation.institution_id).toBe(owner.id);
  });

  it("tracks suspension, and processing is idempotent", async () => {
    const installationId = randomGithubId();
    fixtures.installationIds.push(installationId);
    await processGithubEvent(deps, await storeEvent("installation", installationPayload("created", installationId, 1)));

    const suspend = await storeEvent("installation", installationPayload("suspend", installationId, 1));
    await processGithubEvent(deps, suspend);
    await processGithubEvent(deps, suspend);
    const suspended = await db
      .selectFrom("github_installations")
      .select("suspended_at")
      .where("installation_id", "=", installationId)
      .executeTakeFirstOrThrow();
    expect(suspended.suspended_at).not.toBeNull();

    const row = await db
      .selectFrom("github_events")
      .select("attempts")
      .where("id", "=", suspend)
      .executeTakeFirstOrThrow();
    expect(row.attempts).toBe(1);

    await processGithubEvent(
      deps,
      await storeEvent("installation", installationPayload("unsuspend", installationId, 1)),
    );
    const resumed = await db
      .selectFrom("github_installations")
      .select("suspended_at")
      .where("installation_id", "=", installationId)
      .executeTakeFirstOrThrow();
    expect(resumed.suspended_at).toBeNull();
  });

  it("records the error and rethrows on a malformed payload, so pg-boss retries", async () => {
    const eventId = await storeEvent("installation", { action: "created", installation: { id: 1 } });
    await expect(processGithubEvent(deps, eventId)).rejects.toThrow();
    const row = await db
      .selectFrom("github_events")
      .select(["error", "processed_at", "attempts"])
      .where("id", "=", eventId)
      .executeTakeFirstOrThrow();
    expect(row.error).toBeTruthy();
    expect(row.processed_at).toBeNull();
    expect(row.attempts).toBe(1);
  });
});

describe("sweep", () => {
  it("re-enqueues old unprocessed events only", async () => {
    // Older than any other leftover row, so it is within the sweep's first 500.
    const old = await storeEvent("ping", {}, new Date("2000-01-01T00:00:00Z"));
    const fresh = await storeEvent("ping", {});
    queue.sent = [];
    await sweepUnprocessedEvents(deps);
    const ids = queue.sent.map((s) => (s.data as { eventId: number }).eventId);
    expect(ids).toContain(old);
    expect(ids).not.toContain(fresh);
    await sql`update github_events set processed_at = now() where id = ${old}`.execute(db);
  });
});
