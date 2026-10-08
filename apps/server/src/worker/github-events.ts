import { sql, withActor, type Db } from "@hbe/db";
import {
  installationEventSchema,
  issuesEventSchema,
  pullRequestEventSchema,
  pullRequestReviewEventSchema,
  pushEventSchema,
  type InstallationEvent,
} from "@hbe/github";
import type { JobQueue } from "@hbe/queue";
import type { FastifyBaseLogger } from "fastify";
import { handleIssue, handlePullRequest, handlePullRequestReview, handlePush } from "./activity.ts";

export interface WorkerDeps {
  db: Db;
  queue: JobQueue;
  log: FastifyBaseLogger;
}

const SWEEP_MIN_AGE_SECONDS = 120;
const MAX_ATTEMPTS = 10;

/**
 * Processes one stored delivery. Idempotent: a processed event is skipped, and every
 * write is an upsert, so redelivery and retries are safe.
 */
export async function processGithubEvent(deps: WorkerDeps, eventId: number): Promise<void> {
  const { db, log } = deps;
  const event = await db.selectFrom("github_events").selectAll().where("id", "=", eventId).executeTakeFirst();
  if (!event || event.processed_at) return;

  await db
    .updateTable("github_events")
    .set((eb) => ({ attempts: eb("attempts", "+", 1) }))
    .where("id", "=", eventId)
    .execute();

  try {
    switch (event.event) {
      case "installation":
        await handleInstallation(deps, installationEventSchema.parse(event.payload));
        break;
      case "push":
        await handlePush(deps, pushEventSchema.parse(event.payload));
        break;
      case "pull_request":
        await handlePullRequest(deps, pullRequestEventSchema.parse(event.payload));
        break;
      case "pull_request_review":
        await handlePullRequestReview(deps, pullRequestReviewEventSchema.parse(event.payload));
        break;
      case "issues":
        await handleIssue(deps, issuesEventSchema.parse(event.payload));
        break;
      case "ping":
        break;
      default:
        // Stored and kept for reconciliation; no normaliser needed for this event type.
        log.debug({ eventId, event: event.event }, "no handler for event type");
    }
    await db
      .updateTable("github_events")
      .set({ processed_at: new Date(), error: null })
      .where("id", "=", eventId)
      .execute();
  } catch (err) {
    await db
      .updateTable("github_events")
      .set({ error: err instanceof Error ? err.message.slice(0, 2000) : String(err) })
      .where("id", "=", eventId)
      .execute();
    throw err; // pg-boss retries with backoff
  }
}

async function handleInstallation({ db, log }: WorkerDeps, event: InstallationEvent): Promise<void> {
  const { installation, action, sender } = event;
  const now = new Date();

  await db
    .insertInto("github_installations")
    .values({
      installation_id: installation.id,
      account_id: installation.account.id,
      account_login: installation.account.login,
      account_type: installation.account.type as "Organization" | "User" | "Enterprise",
      repository_selection: installation.repository_selection ?? null,
      permissions: JSON.stringify(installation.permissions),
      events: installation.events,
      suspended_at: action === "suspend" ? now : null,
      deleted_at: action === "deleted" ? now : null,
    })
    .onConflict((oc) =>
      oc.column("installation_id").doUpdateSet((eb) => ({
        account_login: eb.ref("excluded.account_login"),
        repository_selection: eb.ref("excluded.repository_selection"),
        permissions: eb.ref("excluded.permissions"),
        events: eb.ref("excluded.events"),
        suspended_at:
          action === "suspend"
            ? eb.ref("excluded.suspended_at")
            : action === "unsuspend"
              ? null
              : eb.ref("github_installations.suspended_at"),
        deleted_at:
          action === "deleted"
            ? eb.ref("excluded.deleted_at")
            : action === "created"
              ? null
              : eb.ref("github_installations.deleted_at"),
      })),
    )
    .execute();

  if (action !== "created") return;

  // Link to the institution whose admin started a link request and is the GitHub user who installed.
  const request = await db
    .selectFrom("github_link_requests")
    .select(["id", "institution_id", "requested_by"])
    .where("github_user_id", "=", sender.id)
    .where("completed_at", "is", null)
    .where("expires_at", ">", now)
    .orderBy("created_at", "desc")
    .executeTakeFirst();
  if (!request) {
    log.info(
      { installationId: installation.id, sender: sender.login },
      "installation created without a matching link request",
    );
    return;
  }

  await withActor(db, request.requested_by, async (tx) => {
    const linked = await tx
      .updateTable("github_installations")
      .set({ institution_id: request.institution_id, linked_at: now, linked_by: request.requested_by })
      .where("installation_id", "=", installation.id)
      .where("institution_id", "is", null)
      .returning("id")
      .executeTakeFirst();
    if (!linked) {
      log.warn({ installationId: installation.id }, "installation already linked to an institution; not relinking");
      return;
    }
    await tx
      .updateTable("github_link_requests")
      .set({ completed_at: now, installation_id: installation.id })
      .where("id", "=", request.id)
      .execute();
    await tx
      .updateTable("github_events")
      .set({ institution_id: request.institution_id })
      .where("installation_id", "=", installation.id)
      .where("institution_id", "is", null)
      .execute();
  });
  log.info({ installationId: installation.id, institutionId: request.institution_id }, "GitHub installation linked");
}

/** Re-enqueues deliveries that were stored but not processed (enqueue failed, worker crashed). */
export async function sweepUnprocessedEvents({ db, queue, log }: WorkerDeps): Promise<number> {
  const stale = await db
    .selectFrom("github_events")
    .select("id")
    .where("processed_at", "is", null)
    .where("attempts", "<", MAX_ATTEMPTS)
    .where("received_at", "<", sql<Date>`now() - make_interval(secs => ${SWEEP_MIN_AGE_SECONDS})`)
    .orderBy("received_at")
    .limit(500)
    .execute();
  for (const { id } of stale) await queue.send("github-event", { eventId: id }, { singletonKey: `event-${id}` });
  if (stale.length) log.info({ count: stale.length }, "re-enqueued unprocessed webhook events");
  return stale.length;
}
