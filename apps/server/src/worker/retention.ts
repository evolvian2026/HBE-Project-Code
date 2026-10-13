import type { Db } from "@hbe/db";
import type { Settings } from "@hbe/settings";
import { sql, type RawBuilder } from "kysely";
import type { ArchiveStore } from "../archive.ts";
import { EXPORT_BUCKET } from "../records/deps.ts";
import type { ObjectStore } from "../storage.ts";

const DAY_MS = 86_400_000;
const BATCH = 1000;

export interface RetentionResult {
  webhookEvents: number;
  emails: number;
  notifications: number;
  exports: number;
}

/**
 * Deletes what the platform keeps only for a while (`retention` in the plan profile): raw
 * webhook payloads once processed, sent and failed emails, notifications read long ago, and
 * full-export ZIPs. Records themselves follow the institution's contract (records/lifecycle.ts).
 */
export async function sweepRetention(
  { db, store, archive, settings }: { db: Db; store: ObjectStore; archive: ArchiveStore | null; settings: Settings },
  now = new Date(),
): Promise<RetentionResult> {
  const r = settings.profile.retention;
  const before = (days: number) => new Date(now.getTime() - days * DAY_MS);

  // Unprocessed deliveries are kept whatever their age: they still have work to do.
  const webhookEvents = await inBatches(
    (limit) => sql<{ n: number }>`
      with gone as (
        delete from github_events where id in (
          select id from github_events
          where processed_at is not null and received_at < ${before(r.raw_webhook_days)} limit ${limit})
        returning 1)
      select count(*)::int as n from gone`,
    db,
  );
  const emails = await inBatches(
    (limit) => sql<{ n: number }>`
      with gone as (
        delete from email_outbox where id in (
          select id from email_outbox
          where status in ('sent', 'failed') and created_at < ${before(r.email_outbox_days)} limit ${limit})
        returning 1)
      select count(*)::int as n from gone`,
    db,
  );
  const notifications = await inBatches(
    (limit) => sql<{ n: number }>`
      with gone as (
        delete from notifications where id in (
          select id from notifications
          where read_at is not null and read_at < ${before(r.read_notification_days)} limit ${limit})
        returning 1)
      select count(*)::int as n from gone`,
    db,
  );

  // Export ZIPs hold everyone's records: the file first, then the row (a failed export has none).
  const oldExports = await db
    .selectFrom("record_exports")
    .select(["id", "location", "path"])
    .where("status", "in", ["ready", "failed"])
    .where("created_at", "<", before(r.record_export_days))
    .execute();
  const inStorage = oldExports.filter((e) => e.location === "storage" && e.path).map((e) => e.path!);
  const inArchive = oldExports.filter((e) => e.location === "archive" && e.path).map((e) => e.path!);
  for (let i = 0; i < inStorage.length; i += 100) await store.remove(EXPORT_BUCKET, inStorage.slice(i, i + 100));
  if (inArchive.length) {
    if (!archive) throw new Error("Old exports are in the archive bucket, but no archive bucket is configured");
    await archive.remove(inArchive);
  }
  if (oldExports.length) {
    await db
      .deleteFrom("record_exports")
      .where(
        "id",
        "in",
        oldExports.map((e) => e.id),
      )
      .execute();
  }

  return { webhookEvents, emails, notifications, exports: oldExports.length };
}

async function inBatches(query: (limit: number) => RawBuilder<{ n: number }>, db: Db): Promise<number> {
  let total = 0;
  for (;;) {
    const { rows } = await query(BATCH).execute(db);
    const n = rows[0]?.n ?? 0;
    total += n;
    if (n < BATCH) return total;
  }
}
