import { sql, withActor, type Db } from "@hbe/db";
import { createHash } from "node:crypto";
import { notify } from "../notifications.ts";
import { EXPORT_BUCKET, type RecordsDeps, yearsFrom } from "./deps.ts";

const DAY_MS = 86_400_000;

/**
 * Ends an institution's contract (§12.5): it becomes read-only, and its records are purged
 * `contract_grace_years` after the end date.
 */
export async function endContract(
  db: Db,
  institutionId: string,
  { endedAt, actorId, graceYears }: { endedAt: Date; actorId: string; graceYears: number },
) {
  return withActor(db, actorId, (tx) =>
    tx
      .updateTable("institutions")
      .set({ status: "read_only", contract_ended_at: endedAt, purge_after: yearsFrom(endedAt, graceYears) })
      .where("id", "=", institutionId)
      .where("status", "in", ["active", "read_only"])
      .returning(["id", "status", "contract_ended_at", "purge_after"])
      .executeTakeFirst(),
  );
}

/** Undoes a contract end (a renewal): the institution is active again and nothing is purged. */
export async function reopenContract(db: Db, institutionId: string, actorId: string) {
  return withActor(db, actorId, (tx) =>
    tx
      .updateTable("institutions")
      .set({ status: "active", contract_ended_at: null, purge_after: null })
      .where("id", "=", institutionId)
      .where("status", "=", "read_only")
      .where("contract_ended_at", "is not", null)
      .returning(["id", "status", "contract_ended_at", "purge_after"])
      .executeTakeFirst(),
  );
}

/**
 * Tells institution admins, 90 and 30 days before the purge, that their records will be deleted
 * and that they can export them (in-app, and always by email). Once per institution and notice.
 */
export async function sendPurgeNotices(deps: RecordsDeps, now = new Date()): Promise<number> {
  const { db } = deps;
  const due = await db
    .selectFrom("institutions")
    .select(["id", "name", "slug", "purge_after"])
    .where("status", "=", "read_only")
    .where("purge_after", "is not", null)
    .where("purge_after", ">", now)
    .where("purge_after", "<=", new Date(now.getTime() + 90 * DAY_MS))
    .execute();
  let sent = 0;
  for (const inst of due) {
    const days = Math.ceil((new Date(inst.purge_after!).getTime() - now.getTime()) / DAY_MS);
    const notice = days <= 30 ? 30 : 90;
    const admins = await db
      .selectFrom("institution_memberships")
      .select("user_id")
      .where("institution_id", "=", inst.id)
      .where("role", "=", "admin")
      .where("status", "=", "active")
      .execute();
    for (const a of admins) {
      await notify(
        db,
        {
          institutionId: inst.id,
          userId: a.user_id,
          type: "records_notice",
          title: `${inst.name}'s records will be deleted in ${days} days`,
          body:
            `The contract has ended, so all of ${inst.name}'s records (grades, grade reports, source snapshots ` +
            `and test results) will be permanently deleted on ${new Date(inst.purge_after!).toISOString().slice(0, 10)}. ` +
            "Download a full export before then.",
          link: `/i/${inst.slug}/records`,
          dedupeKey: `purge-notice:${inst.id}:${notice}`,
        },
        deps.queue,
      );
      sent++;
    }
  }
  return sent;
}

/** Purges every institution whose purge date has passed. */
export async function purgeDueInstitutions(deps: RecordsDeps, now = new Date()): Promise<string[]> {
  const due = await deps.db
    .selectFrom("institutions")
    .select("id")
    .where("status", "=", "read_only")
    .where("purge_after", "<=", now)
    .execute();
  const purged: string[] = [];
  for (const inst of due) {
    await purgeInstitution(deps, inst.id);
    purged.push(inst.id);
  }
  return purged;
}

/** Tables in `public` with an institution_id column: what a tenant owns. */
async function tenantCounts(db: Db, institutionId: string): Promise<Record<string, number>> {
  const { rows: tables } = await sql<{ table_name: string }>`
    select c.table_name from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public' and c.column_name = 'institution_id' and t.table_type = 'BASE TABLE'
      and c.table_name <> 'audit_logs'
    order by 1`.execute(db);
  const counts: Record<string, number> = {};
  for (const { table_name } of tables) {
    const { rows } = await sql<{ n: number }>`
      select count(*)::int as n from ${sql.table(table_name)} where institution_id = ${institutionId}`.execute(db);
    if (rows[0]!.n) counts[table_name] = rows[0]!.n;
  }
  return counts;
}

/**
 * Deletes everything an institution has (§12.5): its files in Storage and their replicas, then
 * its rows (one cascading delete, unaudited so no personal data is copied into the audit log),
 * and the accounts of people who belonged to no other institution. What is left: the institution
 * row, marked purged, and a certificate in the audit log with what was deleted (counts and a
 * hash of the deleted object list), which holds no personal data.
 */
export async function purgeInstitution(deps: RecordsDeps, institutionId: string) {
  const { db, store, archive, log } = deps;
  const inst = await db
    .selectFrom("institutions")
    .selectAll()
    .where("id", "=", institutionId)
    .executeTakeFirstOrThrow();
  if (inst.status === "purged") return null;

  // Files: Storage first, then the archive's replicas and exports.
  const { rows: objects } = await sql<{ bucket: string; path: string }>`
    select 'grade-reports' as bucket, json_path as path from grade_reports where institution_id = ${institutionId}
    union all select 'grade-reports', pdf_path from grade_reports where institution_id = ${institutionId}
    union all select 'submission-archive', bundle_path from submission_snapshots where institution_id = ${institutionId}
    union all select 'submission-archive', tarball_path from submission_snapshots where institution_id = ${institutionId}
    union all select 'run-artifacts', path from run_artifacts where institution_id = ${institutionId}
    union all select ${EXPORT_BUCKET}, path from record_exports
      where institution_id = ${institutionId} and location = 'storage' and path is not null
    order by 1, 2`.execute(db);
  const byBucket = new Map<string, string[]>();
  for (const o of objects) byBucket.set(o.bucket, [...(byBucket.get(o.bucket) ?? []), o.path]);
  for (const [bucket, paths] of byBucket) {
    for (let i = 0; i < paths.length; i += 100) await store.remove(bucket, paths.slice(i, i + 100));
  }
  const replicas = [
    ...(
      await db
        .selectFrom("replicated_objects")
        .select(["bucket", "path"])
        .where("institution_id", "=", institutionId)
        .execute()
    ).map((r) => `${r.bucket}/${r.path}`),
    ...(
      await db
        .selectFrom("record_exports")
        .select("path")
        .where("institution_id", "=", institutionId)
        .where("location", "=", "archive")
        .where("path", "is not", null)
        .execute()
    ).map((r) => r.path!),
  ];
  if (replicas.length) {
    if (!archive) throw new Error("This institution has archived files, but no archive bucket is configured");
    await archive.remove(replicas);
  }

  const rows = await tenantCounts(db, institutionId);
  const objectList = objects.map((o) => `${o.bucket}/${o.path}`).concat(replicas.map((k) => `archive:${k}`));
  const certificate = {
    purged_at: new Date().toISOString(),
    contract_ended_at: inst.contract_ended_at,
    purge_after: inst.purge_after,
    rows,
    objects: Object.fromEntries([...byBucket].map(([b, p]) => [b, p.length])),
    replicas: replicas.length,
    objects_sha256: createHash("sha256").update(objectList.join("\n")).digest("hex"),
    users_deleted: 0,
  };

  await db.transaction().execute(async (tx) => {
    await sql`select set_config('hbe.skip_audit', 'on', true)`.execute(tx);
    const members = (
      await tx
        .selectFrom("institution_memberships")
        .select("user_id")
        .where("institution_id", "=", institutionId)
        .execute()
    ).map((m) => m.user_id);
    await tx.deleteFrom("institutions").where("id", "=", institutionId).execute();
    await tx
      .insertInto("institutions")
      .values({
        id: inst.id,
        name: inst.name,
        slug: inst.slug,
        status: "purged",
        contract_started_at: inst.contract_started_at,
        contract_ended_at: inst.contract_ended_at,
        purge_after: inst.purge_after,
        created_by: null,
        created_at: inst.created_at,
      })
      .execute();
    // People who belonged only to this institution (and aren't platform staff) go too.
    if (members.length) {
      const { rows: gone } = await sql<{ id: string }>`
        delete from auth.users u
        where u.id = any (${members}::uuid[])
          and not exists (select 1 from public.institution_memberships m where m.user_id = u.id)
          and not exists (select 1 from public.user_roles r where r.user_id = u.id)
        returning u.id`.execute(tx);
      certificate.users_deleted = gone.length;
    }
    await tx.deleteFrom("audit_logs").where("institution_id", "=", institutionId).execute();
    await tx
      .insertInto("audit_logs")
      .values({
        institution_id: institutionId,
        actor_id: null,
        action: "purge",
        entity: "institution",
        entity_id: institutionId,
        before: null,
        after: JSON.stringify(certificate),
      })
      .execute();
  });
  log.info({ institutionId, rows: Object.values(rows).reduce((a, b) => a + b, 0) }, "institution purged");
  return certificate;
}
