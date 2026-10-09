import { courseRoleFromLti, type LtiServices } from "@hbe/lms";
import type { Db } from "@hbe/db";
import type { JobQueue } from "@hbe/queue";
import type { Settings } from "@hbe/settings";
import { servicesFor } from "./services.ts";

export interface LmsDeps {
  db: Db;
  settings: Settings;
  queue?: JobQueue;
}

const MAX_RECONCILE_RETRIES = 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 500);

/** The LMS courses linked to a platform course that offer grade passback, with their connection. */
async function gradebooksOf(db: Db, courseId: string) {
  return db
    .selectFrom("lms_course_links as l")
    .innerJoin("lms_connections as c", "c.id", "l.lms_connection_id")
    .select([
      "l.id",
      "l.institution_id",
      "l.ags_lineitems_url",
      "c.id as connection_id",
      "c.issuer",
      "c.client_id",
      "c.deployment_ids",
      "c.auth_login_url",
      "c.auth_token_url",
      "c.jwks_url",
    ])
    .where("l.course_id", "=", courseId)
    .where("l.ags_lineitems_url", "is not", null)
    .where("c.status", "=", "active")
    .execute();
}

/**
 * The gradebook column of an assignment in an LMS course: the one recorded (from deep linking
 * or a launch), else the one the tool made earlier (found by its resourceId), else a new one.
 */
export async function ensureLineItem(
  db: Db,
  services: LtiServices,
  link: { id: string; institution_id: string; ags_lineitems_url: string | null },
  assignment: { id: string; title: string },
): Promise<{ id: string; lineitem_url: string; score_maximum: number }> {
  const existing = await db
    .selectFrom("lms_assignment_links")
    .select(["id", "lineitem_url", "score_maximum"])
    .where("lms_course_link_id", "=", link.id)
    .where("assignment_id", "=", assignment.id)
    .executeTakeFirst();
  if (existing?.lineitem_url) {
    return { id: existing.id, lineitem_url: existing.lineitem_url, score_maximum: Number(existing.score_maximum) };
  }
  const item =
    (await services.findLineItem(link.ags_lineitems_url!, assignment.id)) ??
    (await services.createLineItem(link.ags_lineitems_url!, {
      label: assignment.title,
      scoreMaximum: 100,
      resourceId: assignment.id,
      tag: "hbe-grade",
    }));
  const row = await db
    .insertInto("lms_assignment_links")
    .values({
      institution_id: link.institution_id,
      assignment_id: assignment.id,
      lms_course_link_id: link.id,
      lineitem_url: item.id,
      score_maximum: String(item.scoreMaximum || 100),
    })
    .onConflict((oc) =>
      oc.columns(["lms_course_link_id", "assignment_id"]).doUpdateSet({
        lineitem_url: item.id,
        score_maximum: String(item.scoreMaximum || 100),
      }),
    )
    .returning(["id", "score_maximum"])
    .executeTakeFirstOrThrow();
  return { id: row.id, lineitem_url: item.id, score_maximum: Number(row.score_maximum) };
}

export interface SyncSummary {
  synced: number;
  skipped: number;
  failed: number;
}

/**
 * Sends a released grade to every LMS gradebook linked to its course (AGS): one score per
 * (grade version, column), recorded in lms_grade_syncs so a version is sent once unless forced.
 * Only the current released version is sent; failures are recorded and thrown, so the job
 * retries.
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
  for (const book of await gradebooksOf(db, g.course_id)) {
    let linkId: string | null = null;
    try {
      const services = await servicesFor(settings, { ...book, id: book.connection_id });
      const column = await ensureLineItem(db, services, book, { id: g.assignment_id, title: g.title });
      linkId = column.id;
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
        .where("lms_connection_id", "=", book.connection_id)
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
              "The student's LMS account isn't known yet: they haven't opened the platform from the LMS, and the roster hasn't been synced.",
          })
          .where("id", "=", row.id)
          .execute();
        summary.skipped++;
        continue;
      }
      const scoreGiven = round2((Number(g.final_score) / 100) * column.score_maximum);
      await services.postScore(column.lineitem_url, {
        userId: lmsUser.lms_user_id,
        scoreGiven,
        scoreMaximum: column.score_maximum,
        comment: `Grade report: ${settings.env.APP_URL}/i/${g.slug}/courses/${g.course_id}/assignments/${g.assignment_id}`,
        timestamp: new Date(g.released_at).toISOString(),
        activityProgress: "Completed",
        gradingProgress: "FullyGraded",
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
      if (linkId) {
        await db
          .updateTable("lms_grade_syncs")
          .set((eb) => ({ status: "failed", attempts: eb("attempts", "+", 1), last_error: errorText(err) }))
          .where("grade_id", "=", g.id)
          .where("lms_assignment_link_id", "=", linkId)
          .execute();
      }
    }
  }
  if (errors.length) throw new Error(`Grade ${gradeId} could not be sent to the LMS: ${errors.join("; ")}`);
  return summary;
}

/** Queues the current released grades of a course (after its LMS course is linked). */
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
  for (const { id } of grades) {
    await queue.send("lms-grade-sync", { gradeId: id, force: false }, { singletonKey: `lms-${id}` });
  }
  return grades.length;
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
  for (const { id } of grades) {
    await queue.send("lms-grade-sync", { gradeId: id, force: opts.force ?? false }, { singletonKey: `lms-${id}` });
  }
  return grades.length;
}

export interface RosterSummary {
  members: number;
  linked: number;
  waiting: number;
  added: number;
  inactive: number;
}

/**
 * Reads an LMS course's roster (NRPS) and matches its people as launches do: earlier links,
 * else their email among the institution's members (anyone else waits for an admin). Learners
 * who are members join the linked course. Nobody is removed: leaving the LMS course is reported,
 * not acted on.
 */
export async function syncRoster(deps: LmsDeps, courseLinkId: string): Promise<RosterSummary | null> {
  const { db, settings } = deps;
  const link = await db
    .selectFrom("lms_course_links as l")
    .innerJoin("lms_connections as c", "c.id", "l.lms_connection_id")
    .innerJoin("institutions as i", "i.id", "l.institution_id")
    .select([
      "l.id",
      "l.institution_id",
      "l.course_id",
      "l.nrps_url",
      "c.id as connection_id",
      "c.issuer",
      "c.client_id",
      "c.deployment_ids",
      "c.auth_login_url",
      "c.auth_token_url",
      "c.jwks_url",
      "c.status",
      "i.status as institution_status",
    ])
    .where("l.id", "=", courseLinkId)
    .executeTakeFirst();
  if (!link?.nrps_url || link.status !== "active" || link.institution_status !== "active") return null;

  const services = await servicesFor(settings, { ...link, id: link.connection_id });
  const members = await services.members(link.nrps_url);
  const summary: RosterSummary = { members: 0, linked: 0, waiting: 0, added: 0, inactive: 0 };
  const institutionMembers = new Map(
    (
      await db
        .selectFrom("institution_memberships as m")
        .innerJoin("profiles as p", "p.id", "m.user_id")
        .select(["p.id", "p.email"])
        .where("m.institution_id", "=", link.institution_id)
        .where("m.status", "=", "active")
        .execute()
    ).map((m) => [m.email?.toLowerCase() ?? "", m.id]),
  );
  const memberIds = new Set(institutionMembers.values());

  for (const m of members) {
    if (m.status !== "Active") {
      summary.inactive++;
      continue;
    }
    summary.members++;
    const existing = await db
      .selectFrom("lms_user_links")
      .select(["id", "profile_id", "status"])
      .where("lms_connection_id", "=", link.connection_id)
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
          institution_id: link.institution_id,
          lms_connection_id: link.connection_id,
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
    if (link.course_id && courseRoleFromLti(m.roles) === "student" && memberIds.has(profileId)) {
      const added = await db
        .insertInto("course_memberships")
        .values({
          institution_id: link.institution_id,
          course_id: link.course_id,
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
    .where("id", "=", link.id)
    .execute();
  // Grades skipped because a student's LMS account wasn't known can go now.
  if (deps.queue && summary.linked) {
    const skipped = await db
      .selectFrom("lms_grade_syncs as y")
      .innerJoin("lms_assignment_links as al", "al.id", "y.lms_assignment_link_id")
      .innerJoin("grades as g", "g.id", "y.grade_id")
      .select("y.grade_id")
      .where("al.lms_course_link_id", "=", link.id)
      .where("y.status", "=", "skipped")
      .where("g.is_current", "=", true)
      .execute();
    for (const { grade_id } of skipped) {
      await deps.queue.send("lms-grade-sync", { gradeId: grade_id, force: false }, { singletonKey: `lms-${grade_id}` });
    }
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
 * released grades that were never sent (e.g. released before the course was linked), and
 * retries failed sends.
 */
export async function reconcileGrades(deps: LmsDeps & { queue: JobQueue }): Promise<ReconcileSummary> {
  const { db, settings, queue } = deps;
  const summary: ReconcileSummary = { checked: 0, conflicts: 0, queued: 0 };

  const columns = await db
    .selectFrom("lms_assignment_links as al")
    .innerJoin("lms_course_links as l", "l.id", "al.lms_course_link_id")
    .innerJoin("lms_connections as c", "c.id", "l.lms_connection_id")
    .innerJoin("institutions as i", "i.id", "al.institution_id")
    .select([
      "al.id",
      "al.lineitem_url",
      "al.score_maximum",
      "c.id as connection_id",
      "c.issuer",
      "c.client_id",
      "c.deployment_ids",
      "c.auth_login_url",
      "c.auth_token_url",
      "c.jwks_url",
    ])
    .where("al.lineitem_url", "is not", null)
    .where("c.status", "=", "active")
    .where("i.status", "=", "active")
    .execute();
  for (const col of columns) {
    const sent = await db
      .selectFrom("lms_grade_syncs as y")
      .innerJoin("grades as g", "g.id", "y.grade_id")
      .select(["y.id", "y.lms_user_id", "y.score_given", "y.status"])
      .where("y.lms_assignment_link_id", "=", col.id)
      .where("g.is_current", "=", true)
      .where("y.status", "in", ["synced", "conflict"])
      .execute();
    if (!sent.length) continue;
    let results;
    try {
      const services = await servicesFor(settings, { ...col, id: col.connection_id });
      results = new Map((await services.results(col.lineitem_url!)).map((r) => [r.userId, r]));
    } catch {
      continue; // The LMS is unreachable tonight; the next run checks again.
    }
    const max = Number(col.score_maximum);
    for (const y of sent) {
      const r = y.lms_user_id ? results.get(y.lms_user_id) : undefined;
      if (!r || r.resultScore === null) continue;
      summary.checked++;
      const lmsPercent = (r.resultScore / (r.resultMaximum || max)) * 100;
      const ourPercent = (Number(y.score_given) / max) * 100;
      const conflict = Math.abs(lmsPercent - ourPercent) > 0.05;
      if (conflict) summary.conflicts++;
      await db
        .updateTable("lms_grade_syncs")
        .set({
          status: conflict ? "conflict" : "synced",
          lms_score: String(round2((lmsPercent / 100) * max)),
          checked_at: new Date(),
          last_error: conflict ? "The grade was changed in the LMS." : null,
        })
        .where("id", "=", y.id)
        .execute();
    }
  }

  // Released grades not in a linked gradebook yet: never sent (e.g. released before the course
  // was linked), skipped (the student's LMS account wasn't known), or failed and worth a retry.
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
    .where("l.ags_lineitems_url", "is not", null)
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
  for (const { id } of missing) {
    await queue.send("lms-grade-sync", { gradeId: id, force: false }, { singletonKey: `lms-${id}` });
    summary.queued++;
  }
  return summary;
}

/** Nightly: queues a roster sync for every linked LMS course that offers NRPS. */
export async function queueRosterSyncs(db: Db, queue: JobQueue): Promise<number> {
  const links = await db
    .selectFrom("lms_course_links as l")
    .innerJoin("lms_connections as c", "c.id", "l.lms_connection_id")
    .select("l.id")
    .where("l.course_id", "is not", null)
    .where("l.nrps_url", "is not", null)
    .where("c.status", "=", "active")
    .execute();
  for (const { id } of links)
    await queue.send("lms-roster-sync", { courseLinkId: id }, { singletonKey: `roster-${id}` });
  return links.length;
}
