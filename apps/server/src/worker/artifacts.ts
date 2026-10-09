import type { Db } from "@hbe/db";
import { ARTIFACT_BUCKET } from "../routes/runs.ts";
import type { ObjectStore } from "../storage.ts";

const BATCH = 500;

/**
 * Deletes run artifacts past their expiry (files of runs that weren't graded), from Storage
 * first and then their rows, a batch at a time. Graded runs' artifacts have no expiry: they
 * follow the institution's records retention.
 */
export async function sweepExpiredArtifacts(
  { db, store }: { db: Db; store: ObjectStore },
  now = new Date(),
): Promise<number> {
  let deleted = 0;
  for (;;) {
    const rows = await db
      .selectFrom("run_artifacts")
      .select(["id", "path"])
      .where("expires_at", "<=", now)
      .orderBy("expires_at")
      .limit(BATCH)
      .execute();
    if (rows.length === 0) return deleted;
    await store.remove(
      ARTIFACT_BUCKET,
      rows.map((r) => r.path),
    );
    await db
      .deleteFrom("run_artifacts")
      .where(
        "id",
        "in",
        rows.map((r) => r.id),
      )
      .execute();
    deleted += rows.length;
    if (rows.length < BATCH) return deleted;
  }
}
