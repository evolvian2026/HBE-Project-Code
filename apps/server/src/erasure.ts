import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sql, type Db } from "@hbe/db";
import type { JobQueue } from "@hbe/queue";
import type { Settings } from "@hbe/settings";
import type { FastifyBaseLogger } from "fastify";
import type { ArchiveStore } from "./archive.ts";
import { notify } from "./notifications.ts";
import { EXPORT_BUCKET } from "./records/deps.ts";
import type { GradeReport } from "./reports/data.ts";
import { REPORTS_BUCKET } from "./reports/index.ts";
import { renderGradeReportPdf } from "./reports/pdf.ts";
import type { ObjectStore } from "./storage.ts";

/**
 * Erasing a person's data in one institution (FR-9.6, docs/ARCHITECTURE.md §12.5). The
 * institution's admins choose:
 * - anonymise: the records stay, owned by a pseudonymous placeholder account, with every
 *   identifier that leads back to the person removed (profile, git and GitHub identities,
 *   LMS and Google links, invitations, notifications, emails, the audit log's copies, and the
 *   student block of each grade report, re-rendered);
 * - delete: the same, then the person's own records and their files are deleted too. Work
 *   shared with a team stays (it is the teammates' record too), as the placeholder's.
 * Two steps, so a failure in the second can be retried: the database (one transaction, with
 * row auditing off so the audit log doesn't copy what is removed), then the files.
 * Their account is deleted too unless they belong to another institution.
 */
export interface ErasureDeps {
  db: Db;
  store: ObjectStore;
  archive: ArchiveStore | null;
  settings: Settings;
  log: FastifyBaseLogger;
  queue?: JobQueue;
}

const LABEL = { student: "Erased student", teacher: "Erased teacher", admin: "Erased admin" } as const;

export class ErasureRefused extends Error {}

/** Why this person's data can't be erased (yet), or null. */
export async function erasureBlocker(db: Db, institutionId: string, subjectId: string): Promise<string | null> {
  const membership = await db
    .selectFrom("institution_memberships")
    .select(["role", "status"])
    .where("institution_id", "=", institutionId)
    .where("user_id", "=", subjectId)
    .executeTakeFirst();
  if (!membership) return "This person isn't a member of the institution.";
  const platformRole = await db
    .selectFrom("user_roles")
    .select("role")
    .where("user_id", "=", subjectId)
    .executeTakeFirst();
  if (platformRole) return "This person has a platform role: the platform operator must remove it first.";
  if (membership.role === "admin" && membership.status === "active") {
    const { n } = await db
      .selectFrom("institution_memberships")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("institution_id", "=", institutionId)
      .where("role", "=", "admin")
      .where("status", "=", "active")
      .where("user_id", "<>", subjectId)
      .executeTakeFirstOrThrow();
    if (Number(n) === 0) return "This person is the institution's only admin: add another admin first.";
  }
  return null;
}

interface StoredObject {
  bucket: string;
  path: string;
}

/** Carries out an approved request (both steps, or the file step again after a failure). */
export async function erasePerson(deps: ErasureDeps, requestId: string): Promise<"completed" | "skipped"> {
  const request = await deps.db
    .selectFrom("erasure_requests")
    .select(["id", "status", "pseudonym_id"])
    .where("id", "=", requestId)
    .executeTakeFirst();
  if (!request || !["approved", "running", "failed"].includes(request.status)) return "skipped";
  try {
    if (!request.pseudonym_id) await databaseStep(deps, requestId);
    await fileStep(deps, requestId);
    return "completed";
  } catch (err) {
    const message = err instanceof ErasureRefused ? err.message : "The erasure didn't finish; it will be retried.";
    await deps.db
      .updateTable("erasure_requests")
      .set({ status: "failed", error: message })
      .where("id", "=", requestId)
      .execute();
    if (err instanceof ErasureRefused) return "skipped";
    throw err;
  }
}

async function databaseStep(deps: ErasureDeps, requestId: string): Promise<void> {
  await deps.db.transaction().execute(async (tx) => {
    const r = await tx
      .selectFrom("erasure_requests")
      .selectAll()
      .where("id", "=", requestId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (r.pseudonym_id || !r.subject_id || !r.mode) return;
    const institutionId = r.institution_id;
    const subject = r.subject_id;
    // The audit log gets one record of the erasure, not copies of everything it touches.
    await sql`select set_config('hbe.skip_audit', 'on', true)`.execute(tx);

    const blocker = await erasureBlocker(tx, institutionId, subject);
    if (blocker) throw new ErasureRefused(blocker);
    const membership = await tx
      .selectFrom("institution_memberships")
      .select("role")
      .where("institution_id", "=", institutionId)
      .where("user_id", "=", subject)
      .executeTakeFirstOrThrow();
    const profile = await tx
      .selectFrom("profiles")
      .select(["email", "github_user_id", "github_login"])
      .where("id", "=", subject)
      .executeTakeFirst();
    // Every address they're known by here (git aliases, LMS, Google), to find them in text.
    const { rows: otherEmails } = await sql<{ email: string }>`
      select email from commit_author_aliases where institution_id = ${institutionId} and profile_id = ${subject}
      union select email from lms_user_links where institution_id = ${institutionId} and profile_id = ${subject} and email is not null
      union select email from google_accounts where institution_id = ${institutionId} and profile_id = ${subject}`.execute(
      tx,
    );
    const emails = [profile?.email, ...otherEmails.map((e) => e.email)].filter((e): e is string => !!e);

    // The placeholder: an account nobody can sign in to, with only a pseudonym.
    const code = randomBytes(3).toString("hex").toUpperCase();
    const label = `${LABEL[membership.role]} ${code}`;
    const pseudonymId = randomUUID();
    await sql`
      insert into auth.users (id, instance_id, aud, role, raw_app_meta_data, raw_user_meta_data, banned_until, created_at, updated_at)
      values (${pseudonymId}, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
              '{"provider": "erased"}'::jsonb, ${JSON.stringify({ full_name: label })}::jsonb, 'infinity', now(), now())`.execute(
      tx,
    );
    await tx
      .updateTable("profiles")
      .set({ status: "deactivated", anonymised_at: new Date(), email_notification_types: [] })
      .where("id", "=", pseudonymId)
      .execute();
    await tx
      .insertInto("institution_memberships")
      .values({ institution_id: institutionId, user_id: pseudonymId, role: membership.role, status: "deactivated" })
      .execute();

    const { rows: moved } = await sql<{ moved: Record<string, number> }>`
      select private.rekey_person(${institutionId}, ${subject}, ${pseudonymId}) as moved`.execute(tx);
    await tx
      .deleteFrom("institution_memberships")
      .where("institution_id", "=", institutionId)
      .where("user_id", "=", subject)
      .execute();
    const { rows: scrubbed } = await sql<{ done: Record<string, number> }>`
      select private.scrub_person(${institutionId}, ${subject}, ${pseudonymId}, ${label}, ${`erased-${code.toLowerCase()}`},
                                  ${profile?.github_user_id ?? null}, ${profile?.github_login ?? null},
                                  ${emails}::text[]) as done`.execute(tx);

    let deleted: Record<string, number> = {};
    let objects: StoredObject[] = [];
    if (r.mode === "delete") ({ deleted, objects } = await deleteOwnRecords(tx, institutionId, pseudonymId));

    // Their account goes too, unless it's still used elsewhere.
    const elsewhere = await tx
      .selectFrom("institution_memberships")
      .select("institution_id")
      .where("user_id", "=", subject)
      .executeTakeFirst();
    const accountDeleted = !elsewhere;
    if (accountDeleted) await sql`delete from auth.users where id = ${subject}`.execute(tx);

    await tx
      .updateTable("erasure_requests")
      .set({
        status: "running",
        error: null,
        subject_id: null,
        requested_by: r.requested_via === "self" ? null : r.requested_by,
        // Their own words could identify them.
        note: r.requested_via === "self" ? null : r.note,
        pseudonym_id: pseudonymId,
        pseudonym: label,
        pending_objects: JSON.stringify(objects),
        certificate: JSON.stringify({
          mode: r.mode,
          pseudonym: label,
          rows_reassigned: moved[0]?.moved ?? {},
          identifiers_removed: scrubbed[0]?.done ?? {},
          records_deleted: deleted,
          account_deleted: accountDeleted,
        }),
      })
      .where("id", "=", requestId)
      .execute();
  });
}

/** Delete mode: the placeholder's own records (their solo submissions entirely; their grades and personal records on team work). */
async function deleteOwnRecords(
  tx: Db,
  institutionId: string,
  owner: string,
): Promise<{ deleted: Record<string, number>; objects: StoredObject[] }> {
  const subs = await tx
    .selectFrom("submissions")
    .select(["id", "team_id", "repository_id"])
    .where("institution_id", "=", institutionId)
    .where("user_id", "=", owner)
    .execute();
  const solo = subs.filter((s) => !s.team_id).map((s) => s.id);
  const team = subs.filter((s) => s.team_id).map((s) => s.id);
  const all = subs.map((s) => s.id);
  const none = ["00000000-0000-0000-0000-000000000000"];
  const ids = (list: string[]) => (list.length ? list : none);

  // Files first, while the rows saying where they are still exist.
  const { rows: objects } = await sql<StoredObject>`
    select 'grade-reports' as bucket, json_path as path from grade_reports where submission_id = any (${ids(all)}::uuid[])
    union all select 'grade-reports', pdf_path from grade_reports where submission_id = any (${ids(all)}::uuid[])
    union all select 'submission-archive', bundle_path from submission_snapshots where submission_id = any (${ids(solo)}::uuid[])
    union all select 'submission-archive', tarball_path from submission_snapshots where submission_id = any (${ids(solo)}::uuid[])
    union all select 'run-artifacts', a.path from run_artifacts a join evaluation_runs e on e.id = a.run_id
      where e.submission_id = any (${ids(solo)}::uuid[])`.execute(tx);

  const count = async (q: Promise<{ numDeletedRows: bigint }[]>) => Number((await q)[0]?.numDeletedRows ?? 0);
  const deleted: Record<string, number> = {};
  // Personal records on team work (the shared runs and snapshots stay with the team).
  deleted.grades = await count(tx.deleteFrom("grades").where("submission_id", "in", ids(team)).execute());
  deleted.rubric_scores = await count(tx.deleteFrom("rubric_scores").where("submission_id", "in", ids(team)).execute());
  deleted.feedback = await count(tx.deleteFrom("feedback").where("submission_id", "in", ids(team)).execute());
  deleted.regrade_requests = await count(
    tx.deleteFrom("regrade_requests").where("submission_id", "in", ids(team)).execute(),
  );
  deleted.process_snapshots = await count(
    tx.deleteFrom("process_snapshots").where("submission_id", "in", ids(team)).execute(),
  );
  deleted.assignment_extensions = await count(
    tx
      .deleteFrom("assignment_extensions")
      .where("institution_id", "=", institutionId)
      .where("user_id", "=", owner)
      .execute(),
  );
  deleted.commit_claims = await count(
    tx
      .deleteFrom("commit_claims")
      .where("institution_id", "=", institutionId)
      .where("claimed_by", "=", owner)
      .execute(),
  );
  // Solo submissions, with everything under them, then their repositories.
  deleted.submissions = await count(tx.deleteFrom("submissions").where("id", "in", ids(solo)).execute());
  const repos = subs.filter((s) => !s.team_id && s.repository_id).map((s) => s.repository_id!);
  deleted.repositories = repos.length
    ? await count(
        tx
          .deleteFrom("repositories")
          .where("id", "in", repos)
          .where(({ not, exists, selectFrom }) =>
            not(
              exists(selectFrom("submissions as o").select("o.id").whereRef("o.repository_id", "=", "repositories.id")),
            ),
          )
          .execute(),
      )
    : 0;
  return { deleted, objects: objects.filter((o) => o.path) };
}

async function fileStep(deps: ErasureDeps, requestId: string): Promise<void> {
  const { db, store, archive, settings } = deps;
  const r = await db.selectFrom("erasure_requests").selectAll().where("id", "=", requestId).executeTakeFirstOrThrow();
  if (r.status === "completed" || !r.pseudonym_id) return;
  const institutionId = r.institution_id;
  const locked = settings.env.ARCHIVE_OBJECT_LOCK === "compliance";
  const files = {
    reports_rewritten: 0,
    objects_deleted: 0,
    replicas_deleted: 0,
    replicas_locked: 0,
    exports_deleted: 0,
  };

  // Archive copies of changed or deleted files: removed (replication copies the new versions).
  // Under compliance-mode Object Lock nothing can remove them before their lock date.
  const dropReplicas = async (objects: StoredObject[]) => {
    if (!objects.length) return;
    const replicas = await db
      .selectFrom("replicated_objects")
      .select(["bucket", "path"])
      .where("institution_id", "=", institutionId)
      .where((eb) => eb.or(objects.map((o) => eb.and([eb("bucket", "=", o.bucket), eb("path", "=", o.path)]))))
      .execute();
    if (!replicas.length) return;
    if (locked || !archive) {
      files.replicas_locked += replicas.length;
      return;
    }
    await archive.remove(replicas.map((x) => `${x.bucket}/${x.path}`));
    await db
      .deleteFrom("replicated_objects")
      .where("institution_id", "=", institutionId)
      .where((eb) => eb.or(replicas.map((o) => eb.and([eb("bucket", "=", o.bucket), eb("path", "=", o.path)]))))
      .execute();
    files.replicas_deleted += replicas.length;
  };

  // Grade reports that stay: the student block becomes the pseudonym, and the PDF is re-rendered.
  const reports = await db
    .selectFrom("grade_reports")
    .select(["id", "json_path", "pdf_path"])
    .where("institution_id", "=", institutionId)
    .where("user_id", "=", r.pseudonym_id)
    .execute();
  for (const rep of reports) {
    const body = await store.get(REPORTS_BUCKET, rep.json_path);
    if (!body) continue;
    const report = JSON.parse(body.toString("utf8")) as GradeReport & { anonymised_at?: string };
    report.student = { name: r.pseudonym, email: null, github_login: null, student_id: null };
    report.submission.repository = null;
    report.anonymised_at ??= new Date().toISOString();
    const json = JSON.stringify(report, null, 2);
    const sha256 = createHash("sha256").update(json).digest("hex");
    const pdf = await renderGradeReportPdf(report, sha256);
    await store.put(REPORTS_BUCKET, rep.json_path, Buffer.from(json), "application/json");
    await store.put(REPORTS_BUCKET, rep.pdf_path, pdf, "application/pdf");
    await db
      .updateTable("grade_reports")
      .set({ sha256, pdf_sha256: createHash("sha256").update(pdf).digest("hex") })
      .where("id", "=", rep.id)
      .execute();
    await dropReplicas([
      { bucket: REPORTS_BUCKET, path: rep.json_path },
      { bucket: REPORTS_BUCKET, path: rep.pdf_path },
    ]);
    files.reports_rewritten++;
  }

  // Delete mode: the files of the deleted records.
  const pending = (r.pending_objects as unknown as StoredObject[] | null) ?? [];
  const byBucket = new Map<string, string[]>();
  for (const o of pending) byBucket.set(o.bucket, [...(byBucket.get(o.bucket) ?? []), o.path]);
  for (const [bucket, paths] of byBucket) {
    for (let i = 0; i < paths.length; i += 100) await store.remove(bucket, paths.slice(i, i + 100));
  }
  files.objects_deleted = pending.length;
  await dropReplicas(pending);

  // Earlier full exports contain the person: they go (an admin can export again).
  const exports = await db
    .selectFrom("record_exports")
    .select(["id", "location", "path"])
    .where("institution_id", "=", institutionId)
    .execute();
  const inStorage = exports.filter((e) => e.location === "storage" && e.path).map((e) => e.path!);
  const inArchive = exports.filter((e) => e.location === "archive" && e.path).map((e) => e.path!);
  if (inStorage.length) await store.remove(EXPORT_BUCKET, inStorage);
  if (inArchive.length && archive) await archive.remove(inArchive);
  if (exports.length) {
    await db
      .deleteFrom("record_exports")
      .where(
        "id",
        "in",
        exports.map((e) => e.id),
      )
      .execute();
  }
  files.exports_deleted = exports.length;

  const certificate = { ...(r.certificate as Record<string, unknown>), files };
  await db.transaction().execute(async (tx) => {
    await tx
      .updateTable("erasure_requests")
      .set({
        status: "completed",
        completed_at: new Date(),
        pending_objects: null,
        error: null,
        certificate: JSON.stringify(certificate),
      })
      .where("id", "=", requestId)
      .execute();
    await tx
      .insertInto("audit_logs")
      .values({
        institution_id: institutionId,
        actor_id: r.decided_by,
        action: "delete",
        entity: "personal_data",
        entity_id: r.pseudonym_id,
        after: JSON.stringify(certificate),
      })
      .execute();
  });
  if (r.decided_by) {
    await notify(
      db,
      {
        institutionId,
        userId: r.decided_by,
        type: "erasure_request",
        title: `Personal data erased: ${r.pseudonym}`,
        body:
          r.mode === "anonymise"
            ? "Their records stay under this pseudonym; everything that identified them was removed."
            : "Their own records were deleted; work shared with a team stays under this pseudonym.",
        link: `/i/${(await db.selectFrom("institutions").select("slug").where("id", "=", institutionId).executeTakeFirstOrThrow()).slug}/members#erasure`,
        dedupeKey: `erasure:${requestId}`,
      },
      deps.queue,
    );
  }
  deps.log.info({ requestId, mode: r.mode }, "personal data erased");
}
