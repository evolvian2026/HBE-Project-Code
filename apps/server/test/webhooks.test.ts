import { randomUUID } from "node:crypto";
import { signWebhookBody } from "@hbe/github";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { FakeQueue, FakeVerifier, Fixtures, randomGithubId, testDb, testSettings, WEBHOOK_SECRET } from "./helpers.ts";

const db = testDb();
const fixtures = new Fixtures(db);
const queue = new FakeQueue();
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ settings: testSettings(), db, queue, verifier: new FakeVerifier() });
});
beforeEach(() => {
  queue.sent = [];
});
afterAll(async () => {
  await app.close();
  await fixtures.cleanup();
  await db.destroy();
});

function deliver(event: string, payload: unknown, opts: { deliveryId?: string; secret?: string } = {}) {
  const body = JSON.stringify(payload);
  const deliveryId = opts.deliveryId ?? randomUUID();
  fixtures.deliveryIds.push(deliveryId);
  return app.inject({
    method: "POST",
    url: "/webhooks/github",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": signWebhookBody(opts.secret ?? WEBHOOK_SECRET, body),
    },
    payload: body,
  });
}

describe("POST /webhooks/github", () => {
  it("rejects requests without GitHub headers", async () => {
    const res = await app.inject({ method: "POST", url: "/webhooks/github", payload: { a: 1 } });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a bad signature and stores nothing", async () => {
    const deliveryId = randomUUID();
    const res = await deliver("push", { ref: "refs/heads/main" }, { deliveryId, secret: "wrong-secret" });
    expect(res.statusCode).toBe(401);
    const stored = await db
      .selectFrom("github_events")
      .select("id")
      .where("delivery_id", "=", deliveryId)
      .executeTakeFirst();
    expect(stored).toBeUndefined();
    expect(queue.sent).toHaveLength(0);
  });

  it("stores a verified delivery with its envelope and enqueues it", async () => {
    const installationId = randomGithubId();
    const deliveryId = randomUUID();
    const res = await deliver(
      "push",
      {
        ref: "refs/heads/main",
        installation: { id: installationId },
        repository: { full_name: "org/repo" },
        sender: { id: 5, login: "s" },
      },
      { deliveryId },
    );
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ received: true, duplicate: false });

    const row = await db
      .selectFrom("github_events")
      .selectAll()
      .where("delivery_id", "=", deliveryId)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      event: "push",
      installation_id: installationId,
      repository_full_name: "org/repo",
      sender_id: 5,
      institution_id: null,
      processed_at: null,
    });
    expect(queue.sent).toEqual([{ name: "github-event", data: { eventId: row.id } }]);
  });

  it("acknowledges a redelivery without storing or enqueueing it twice", async () => {
    const deliveryId = randomUUID();
    await deliver("ping", { zen: "Design for failure." }, { deliveryId });
    const again = await deliver("ping", { zen: "Design for failure." }, { deliveryId });
    expect(again.statusCode).toBe(202);
    expect(again.json()).toEqual({ received: true, duplicate: true });
    expect(queue.sent).toHaveLength(1);
  });

  it("tags events with the institution that owns the installation", async () => {
    const inst = await fixtures.institution();
    const installationId = randomGithubId();
    fixtures.installationIds.push(installationId);
    await db
      .insertInto("github_installations")
      .values({
        institution_id: inst.id,
        installation_id: installationId,
        account_id: 1,
        account_login: "o",
        account_type: "Organization",
      })
      .execute();
    const deliveryId = randomUUID();
    await deliver("issues", { action: "opened", installation: { id: installationId } }, { deliveryId });
    const row = await db
      .selectFrom("github_events")
      .select("institution_id")
      .where("delivery_id", "=", deliveryId)
      .executeTakeFirstOrThrow();
    expect(row.institution_id).toBe(inst.id);
  });
});
