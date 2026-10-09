import type { Db } from "@hbe/db";
import type { JobQueue } from "@hbe/queue";
import { gradebookOf, gradebooksOfCourse, type Column, type LmsDeps } from "./gradebook.ts";

export type { LmsDeps } from "./gradebook.ts";
export { ensureLineItem } from "./gradebook.ts";

const MAX_RECONCILE_RETRIES = 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 500);

export interface SyncSummary {
  synced: number;
  skipped: number;
  failed: number;
}

/**
 * Sends a released grade to every LMS gradebook linked to its course (LTI AGS or Google
 * Classroom): one score per (grade version, column), recorded in lms_grade_syncs so a version
 * is sent once unless forced. Only the current released version is sent; failures are recorded
 * and thrown, so the job retries.
 */
export async function syncGrade(deps: LmsDeps, gradeId: string, opts: { force?: boolean } = {}): Promise<SyncSummary> {
  const { db, settings } = deps;
  const summary: SyncSummary = { synced: 0, skipped: 0, failed: 0 };
  const g = await db
    .selectFrom("grades as g")
    .innerJoin("submissions as s", "s.id", "g.submission_id")
    .innerJoin("assignments as a", "a.id", "s.assignment_id")
    .innerJoin("institutions as i", "i.id", "g.institution_id")
    .select([
      "g.id",
      "g.institution_id",
      "g.submission_id",
      "g.user_id",
      "g.final_score",
      "g.released_at",
      "g.is_current",
      "a.id as assignment_id",
      "a.title",
      "a.course_id",
      "i.slug",
      "i.status as institution_status",
    ])
    .where("g.id", "=", gradeId)
    .executeTakeFirst();
  if (!g || !g.released_at || !g.is_current || g.institution_status !== "active") return summary;

  const errors: string[] = [];
  for (const book of await gradebooksOfCourse(deps, g.course_id)) {
    let column: Column | null = null;
    try {
      const found = await book.column({ id: g.assignment_id, title: g.title });
      if ("skip" in found) {
        summary.skipped++;
        continue;
      }
      column = found;
      const row = await db
        .insertInto("lms_grade_syncs")
        .values({
          institution_id: g.institution_id,
          grade_id: g.id,
          submission_id: g.submission_id,
          lms_assignment_link_id: column.id,
        })
        .onConflict((oc) => oc.columns(["grade_id", "lms_assignment_link_id"]).doUpdateSet({ updated_at: new Date() }))
        .returning(["id", "status"])
        .executeTakeFirstOrThrow();
      // Sent already, or changed in the LMS since (a teacher decides): only a forced send repeats it.
      if ((row.status === "synced" || row.status === "conflict") && !opts.force) {
        summary.synced++;
        continue;
      }
      const lmsUser = await db
        .selectFrom("lms_user_links")
        .select("lms_user_id")
        .where("lms_connection_id", "=", book.connectionId)
        .where("profile_id", "=", g.user_id)
        .where("status", "=", "linked")
        .orderBy("last_launch_at", (ob) => ob.desc().nullsLast())
        .executeTakeFirst();
      if (!lmsUser) {
        await db
          .updateTable("lms_grade_syncs")
          .set({
            status: "skipped",
            last_error:
              book.kind === "classroom"
                ? "The student isn't in the Google Classroom class (or the roster hasn't been read yet)."
                : "The student's LMS account isn't known yet: they haven't opened the platform from the LMS, and the roster hasn't been synced.",
          })
          .where("id", "=", row.id)
          .execute();
        summary.skipped++;
        continue;
      }
      const scoreGiven = round2((Number(g.final_score) / 100) * column.score_maximum);
      await book.postScore(column, lmsUser.lms_user_id, {
        given: scoreGiven,
        comment: `Grade report: ${settings.env.APP_URL}/i/${g.slug}/courses/${g.course_id}/assignments/${g.assignment_id}`,
        timestamp: new Date(g.released_at),
      });
      await db
        .updateTable("lms_grade_syncs")
        .set((eb) => ({
          status: "synced",
          lms_user_id: lmsUser.lms_user_id,
          score_given: String(scoreGiven),
          lms_score: String(scoreGiven),
          attempts: eb("attempts", "+", 1),
          last_error: null,
          synced_at: new Date(),
        }))
        .where("id", "=", row.id)
        .execute();
      summary.synced++;
    } catch (err) {
      summary.failed++;
      errors.push(errorText(err));
      if (column) {
        await db
          .updateTable("lms_grade_syncs")
          .set((eb) => ({ status: "failed", attempts: eb("attempts", "+", 1), last_error: errorText(err) }))
          .where("grade_id", "=", g.id)
          .where("lms_assignment_link_id", "=", column.id)
          .execute();
      }
    }
  }
  if (errors.length) throw new Error(`Grade ${gradeId} could not be sent to the LMS: ${errors.join("; ")}`);
  return summary;
}

async function queueGrades(queue: JobQueue, gradeIds: string[], force: boolean): Promise<number> {
  for (const id of gradeIds) {
    await queue.send("lms-grade-sync", { gradeId: id, force }, { singletonKey: `lms-${id}` });
  }
  return gradeIds.length;
}

/** Queues the current released grades of a course (after an LMS course is linked to it). */
export async function queueCourseSync(db: Db, queue: JobQueue, courseId: string): Promise<number> {
  const grades = await db
    .selectFrom("grades as g")
    .innerJoin("submissions as s", "s.id", "g.submission_id")
    .innerJoin("assignments as a", "a.id", "s.assignment_id")
    .select("g.id")
    .where("a.course_id", "=", courseId)
    .where("g.is_current", "=", true)
    .where("g.released_at", "is not", null)
    .execute();
  return queueGrades(
    queue,
    grades.map((g) => g.id),
    false,
  );
}

/** Queues the current released grades of an assignment (or some of its submissions) for sending. */
export async function queueAssignmentSync(
  db: Db,
  queue: JobQueue,
  assignmentId: string,
  opts: { submissionIds?: string[]; force?: boolean } = {},
): Promise<number> {
  let query = db
    .selectFrom("grades as g")
    .innerJoin("submissions as s", "s.id", "g.submission_id")
    .select("g.id")
    .where("s.assignment_id", "=", assignmentId)
    .where("g.is_current", "=", true)
    .where("g.released_at", "is not", null);
  if (opts.submissionIds) query = query.where("s.id", "in", opts.submissionIds.length ? opts.submissionIds : [""]);
  const grades = await query.execute();
  return queueGrades(
    queue,
    grades.map((g) => g.id),
    opts.force ?? false,
  );
}

export interface RosterSummary {
  members: number;
  linked: number;
  waiting: number;
  added: number;
  inactive: number;
}

/**
 * Reads an LMS course's roster (NRPS, or the Classroom class's students) and matches its people
 * as launches do: earlier links, else their email among the institution's members (anyone else
 * waits for an admin). Learners who are members join the linked course. Nobody is removed:
 * leaving the LMS course is reported, not acted on.
 */
export async function syncRoster(deps: LmsDeps, courseLinkId: string): Promise<RosterSummary | null> {
  const { db } = deps;
  const book = await gradebookOf(deps, courseLinkId);
  if (!book?.hasRoster) return null;
  const members = await book.members();
  const summary: RosterSummary = { members: 0, linked: 0, waiting: 0, added: 0, inactive: 0 };
  const institutionMembers = new Map(
    (
      await db
        .selectFrom("institution_memberships as m")
        .innerJoin("profiles as p", "p.id", "m.user_id")
        .select(["p.id", "p.email"])
        .where("m.institution_id", "=", book.institutionId)
        .where("m.status", "=", "active")
        .execute()
    ).map((m) => [m.email?.toLowerCase() ?? "", m.id]),
  );
  const memberIds = new Set(institutionMembers.values());

  for (const m of members) {
    if (!m.active) {
      summary.inactive++;
      continue;
    }
    summary.members++;
    const existing = await db
      .selectFrom("lms_user_links")
      .select(["id", "profile_id", "status"])
      .where("lms_connection_id", "=", book.connectionId)
      .where("lms_user_id", "=", m.userId)
      .executeTakeFirst();
    if (existing?.status === "rejected") continue;
    let profileId = existing?.status === "linked" ? existing.profile_id : null;
    if (!profileId && m.email) profileId = institutionMembers.get(m.email) ?? null;
    if (existing) {
      await db
        .updateTable("lms_user_links")
        .set({
          email: m.email,
          name: m.name,
          ...(profileId && existing.status !== "linked"
            ? { profile_id: profileId, status: "linked" as const, matched_by: "email" as const }
            : {}),
        })
        .where("id", "=", existing.id)
        .execute();
    } else {
      await db
        .insertInto("lms_user_links")
        .values({
          institution_id: book.institutionId,
          lms_connection_id: book.connectionId,
          lms_user_id: m.userId,
          email: m.email,
          name: m.name,
          ...(profileId
            ? { profile_id: profileId, status: "linked" as const, matched_by: "email" as const }
            : { profile_id: null, status: "pending" as const, matched_by: null }),
        })
        .execute();
    }
    if (!profileId) {
      summary.waiting++;
      continue;
    }
    summary.linked++;
    if (book.courseId && m.learner && memberIds.has(profileId)) {
      const added = await db
        .insertInto("course_memberships")
        .values({
          institution_id: book.institutionId,
          course_id: book.courseId,
          user_id: profileId,
          role: "student",
          source: "lms",
        })
        .onConflict((oc) => oc.doNothing())
        .returning("id")
        .executeTakeFirst();
      if (added) summary.added++;
    }
  }
  await db
    .updateTable("lms_course_links")
    .set({ roster_synced_at: new Date(), roster_summary: JSON.stringify(summary) })
    .where("id", "=", book.linkId)
    .execute();
  // Grades skipped because a student's LMS account wasn't known can go now.
  if (deps.queue && summary.linked) {
    const skipped = await db
      .selectFrom("lms_grade_syncs as y")
      .innerJoin("lms_assignment_links as al", "al.id", "y.lms_assignment_link_id")
      .innerJoin("grades as g", "g.id", "y.grade_id")
      .select("y.grade_id")
      .where("al.lms_course_link_id", "=", book.linkId)
      .where("y.status", "=", "skipped")
      .where("g.is_current", "=", true)
      .execute();
    await queueGrades(
      deps.queue,
      skipped.map((s) => s.grade_id),
      false,
    );
  }
  return summary;
}

export interface ReconcileSummary {
  checked: number;
  conflicts: number;
  queued: number;
}

/**
 * Nightly: compares what each LMS gradebook shows with the grades sent there and flags the
 * ones changed in the LMS as conflicts (never overwriting them: a teacher decides), queues
 * released grades not in a linked gradebook yet, and retries failed sends.
 */
export async function reconcileGrades(deps: LmsDeps & { queue: JobQueue }): Promise<ReconcileSummary> {
  const { db, queue } = deps;
  const summary: ReconcileSummary = { checked: 0, conflicts: 0, queued: 0 };

  const columns = await db
    .selectFrom("lms_assignment_links")
    .select(["id", "lms_course_link_id", "score_maximum", "lineitem_url", "classroom_coursework_id"])
    .where((eb) => eb.or([eb("lineitem_url", "is not", null), eb("classroom_coursework_id", "is not", null)]))
    .execute();
  for (const col of columns) {
    const sent = await db
      .selectFrom("lms_grade_syncs as y")
      .innerJoin("grades as g", "g.id", "y.grade_id")
      .select(["y.id", "y.lms_user_id", "y.score_given"])
      .where("y.lms_assignment_link_id", "=", col.id)
      .where("g.is_current", "=", true)
      .where("y.status", "in", ["synced", "conflict"])
      .execute();
    if (!sent.length) continue;
    const book = await gradebookOf(deps, col.lms_course_link_id);
    if (!book) continue;
    let results: Map<string, number>;
    try {
      results = await book.results({ ...col, score_maximum: Number(col.score_maximum) });
    } catch {
      continue; // The LMS is unreachable tonight; the next run checks again.
    }
    for (const y of sent) {
      const lmsScore = y.lms_user_id ? results.get(y.lms_user_id) : undefined;
      if (lmsScore === undefined) continue;
      summary.checked++;
      const conflict = Math.abs(lmsScore - Number(y.score_given)) > 0.05;
      if (conflict) summary.conflicts++;
      await db
        .updateTable("lms_grade_syncs")
        .set({
          status: conflict ? "conflict" : "synced",
          lms_score: String(round2(lmsScore)),
          checked_at: new Date(),
          last_error: conflict ? "The grade was changed in the LMS." : null,
        })
        .where("id", "=", y.id)
        .execute();
    }
  }

  // Released grades not in a linked gradebook yet: never sent (e.g. released before the course
  // was linked), skipped (the student wasn't known), or failed and worth a retry.
  const missing = await db
    .selectFrom("grades as g")
    .innerJoin("submissions as s", "s.id", "g.submission_id")
    .innerJoin("assignments as a", "a.id", "s.assignment_id")
    .innerJoin("lms_course_links as l", "l.course_id", "a.course_id")
    .innerJoin("lms_connections as c", "c.id", "l.lms_connection_id")
    .innerJoin("institutions as i", "i.id", "g.institution_id")
    .select("g.id")
    .distinct()
    .where("g.is_current", "=", true)
    .where("g.released_at", "is not", null)
    .where((eb) => eb.or([eb("l.ags_lineitems_url", "is not", null), eb("c.type", "=", "google_classroom")]))
    .where("c.status", "=", "active")
    .where("i.status", "=", "active")
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom("lms_grade_syncs as y")
            .innerJoin("lms_assignment_links as al", "al.id", "y.lms_assignment_link_id")
            .select("y.id")
            .whereRef("y.grade_id", "=", "g.id")
            .whereRef("al.lms_course_link_id", "=", "l.id")
            .where((eb) =>
              eb.or([eb("y.status", "in", ["synced", "conflict"]), eb("y.attempts", ">=", MAX_RECONCILE_RETRIES)]),
            ),
        ),
      ),
    )
    .execute();
  summary.queued = await queueGrades(
    queue,
    missing.map((m) => m.id),
    false,
  );
  return summary;
}

/** Nightly: queues a roster sync for every linked LMS course with a roster. */
export async function queueRosterSyncs(db: Db, queue: JobQueue): Promise<number> {
  const links = await db
    .selectFrom("lms_course_links as l")
    .innerJoin("lms_connections as c", "c.id", "l.lms_connection_id")
    .select("l.id")
    .where("l.course_id", "is not", null)
    .where((eb) => eb.or([eb("l.nrps_url", "is not", null), eb("c.type", "=", "google_classroom")]))
    .where("c.status", "=", "active")
    .execute();
  for (const { id } of links)
    await queue.send("lms-roster-sync", { courseLinkId: id }, { singletonKey: `roster-${id}` });
  return links.length;
}
