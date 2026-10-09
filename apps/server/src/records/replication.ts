import { sql } from "@hbe/db";
import { PassThrough } from "node:stream";
import { type RecordsDeps, yearsFrom } from "./deps.ts";

interface Pending {
  bucket: string;
  path: string;
  institution_id: string;
  content_type: string;
  purge_after: Date | null;
}

/** Record files (reports, snapshots, graded runs' artifacts) not yet in the archive bucket. */
async function pending(deps: RecordsDeps, skip: string[], limit: number): Promise<Pending[]> {
  const { rows } = await sql<Pending>`
    select r.bucket, r.path, r.institution_id, r.content_type, i.purge_after
    from (
      select 'grade-reports' as bucket, json_path as path, institution_id, 'application/json' as content_type
        from grade_reports
      union all select 'grade-reports', pdf_path, institution_id, 'application/pdf' from grade_reports
      union all select 'submission-archive', bundle_path, institution_id, 'application/x-git-bundle'
        from submission_snapshots
      union all select 'submission-archive', tarball_path, institution_id, 'application/gzip' from submission_snapshots
      union all select 'run-artifacts', path, institution_id, content_type from run_artifacts where expires_at is null
    ) r
    join institutions i on i.id = r.institution_id and i.status <> 'purged'
    where not exists (select 1 from replicated_objects o where o.bucket = r.bucket and o.path = r.path)
      and r.bucket || '/' || r.path <> all (${skip}::text[])
    limit ${limit}`.execute(deps.db);
  return rows;
}

/**
 * Copies record files to the archive bucket (docs/ARCHITECTURE.md §12.4): Supabase's database
 * backups don't include Storage. Each object goes to `<bucket>/<path>`, under Object Lock (when
 * configured) until the institution's purge date, or `contract_grace_years` from now while the
 * contract runs. Files that aren't in Storage yet are tried again next time.
 */
export async function replicateRecords(
  deps: RecordsDeps,
  { budgetMs = 10 * 60_000, now = new Date() }: { budgetMs?: number; now?: Date } = {},
): Promise<{ copied: number; missing: number; bytes: number }> {
  const { db, store, archive, settings, log } = deps;
  const result = { copied: 0, missing: 0, bytes: 0 };
  if (!archive) return result;
  const deadline = Date.now() + budgetMs;
  const skip: string[] = [];
  while (Date.now() < deadline) {
    const batch = await pending(deps, skip, 50);
    if (batch.length === 0) break;
    for (const r of batch) {
      const source = await store.stream(r.bucket, r.path);
      if (!source) {
        skip.push(`${r.bucket}/${r.path}`);
        result.missing++;
        continue;
      }
      let size = 0;
      const counted = new PassThrough();
      counted.on("data", (chunk: Buffer) => (size += chunk.length));
      source.on("error", (err) => counted.destroy(err));
      source.pipe(counted);
      const lockUntil = archive.locking
        ? (r.purge_after ?? yearsFrom(now, settings.profile.retention.contract_grace_years))
        : null;
      await archive.put(`${r.bucket}/${r.path}`, counted, { contentType: r.content_type, lockUntil });
      await db
        .insertInto("replicated_objects")
        .values({ bucket: r.bucket, path: r.path, institution_id: r.institution_id, size, locked_until: lockUntil })
        .onConflict((oc) => oc.columns(["bucket", "path"]).doNothing())
        .execute();
      result.copied++;
      result.bytes += size;
    }
  }
  if (result.copied || result.missing) log.info({ ...result, archive: archive.description }, "records replicated");
  return result;
}
