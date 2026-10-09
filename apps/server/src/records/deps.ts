import type { Db } from "@hbe/db";
import type { JobQueue } from "@hbe/queue";
import type { Settings } from "@hbe/settings";
import type { FastifyBaseLogger } from "fastify";
import type { ArchiveStore } from "../archive.ts";
import type { ObjectStore } from "../storage.ts";

export interface RecordsDeps {
  db: Db;
  store: ObjectStore;
  /** The external archive bucket; null when none is configured (local development). */
  archive: ArchiveStore | null;
  settings: Settings;
  log: FastifyBaseLogger;
  queue?: JobQueue;
}

/** The same moment `years` calendar years later. */
export function yearsFrom(date: Date, years: number): Date {
  const later = new Date(date);
  later.setUTCFullYear(later.getUTCFullYear() + years);
  return later;
}

/** Storage buckets holding records (plus exports), all keyed by institution id first. */
export const RECORD_BUCKETS = ["grade-reports", "submission-archive", "run-artifacts"] as const;
export const EXPORT_BUCKET = "record-exports";
