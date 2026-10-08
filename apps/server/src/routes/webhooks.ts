import { extractEnvelope, parseWebhookHeaders, verifyWebhookSignature } from "@hbe/github";
import type { Json } from "@hbe/db";
import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "../app.ts";

const MAX_WEBHOOK_BYTES = 25 * 1024 * 1024; // GitHub caps payloads at 25 MB

/**
 * GitHub App webhooks: verify, persist, enqueue, acknowledge. Nothing slow happens
 * here (GitHub gives up after 10 s); the worker does the processing.
 */
export async function webhookRoutes(app: FastifyInstance, { settings, db, queue }: ApiDeps): Promise<void> {
  const secret = settings.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) throw new Error("GITHUB_WEBHOOK_SECRET is required for the api role");

  // The signature covers the exact bytes, so keep the raw body (scoped to this plugin).
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer", bodyLimit: MAX_WEBHOOK_BYTES },
    (_req, body, done) => done(null, body),
  );

  app.post("/webhooks/github", { bodyLimit: MAX_WEBHOOK_BYTES }, async (req, reply) => {
    const headers = parseWebhookHeaders(req.headers);
    if (!headers) return reply.code(400).send({ error: "invalid_request", message: "Missing GitHub delivery headers" });

    const raw = req.body;
    if (!Buffer.isBuffer(raw) || !verifyWebhookSignature(secret, raw, headers.signature)) {
      req.log.warn({ deliveryId: headers.deliveryId }, "webhook signature verification failed");
      return reply.code(401).send({ error: "invalid_signature" });
    }

    let payload: Json;
    try {
      payload = JSON.parse(raw.toString("utf8")) as Json;
    } catch {
      return reply.code(400).send({ error: "invalid_request", message: "Body is not JSON" });
    }

    const envelope = extractEnvelope(payload);
    const installation = envelope.installationId
      ? await db
          .selectFrom("github_installations")
          .select("institution_id")
          .where("installation_id", "=", envelope.installationId)
          .executeTakeFirst()
      : undefined;

    const inserted = await db
      .insertInto("github_events")
      .values({
        delivery_id: headers.deliveryId,
        event: headers.event,
        action: envelope.action,
        installation_id: envelope.installationId,
        institution_id: installation?.institution_id ?? null,
        repository_full_name: envelope.repositoryFullName,
        sender_id: envelope.senderId,
        payload: JSON.stringify(payload),
      })
      .onConflict((oc) => oc.column("delivery_id").doNothing())
      .returning("id")
      .executeTakeFirst();

    if (!inserted) return reply.code(202).send({ received: true, duplicate: true });

    try {
      await queue.send("github-event", { eventId: inserted.id });
    } catch (err) {
      // Stored is what matters: the sweep schedule re-enqueues unprocessed events.
      req.log.error({ err, eventId: inserted.id }, "failed to enqueue webhook; sweep will retry");
    }
    return reply.code(202).send({ received: true, duplicate: false });
  });
}
