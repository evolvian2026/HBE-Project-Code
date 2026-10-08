import type { Db, NotificationType } from "@hbe/db";
import { sql } from "@hbe/db";
import type { JobQueue } from "@hbe/queue";

export interface NewNotification {
  institutionId: string;
  userId: string;
  type: NotificationType;
  title: string;
  body?: string | null;
  link?: string | null;
  /** The same key is delivered once per user (retries and sweeps are harmless). */
  dedupeKey: string;
}

/**
 * Stores an in-app notification; the database also queues its email if the user wants that
 * type by email. Pass the queue to send the email now rather than at the next minute's sweep.
 */
export async function notify(db: Db, n: NewNotification, queue?: JobQueue): Promise<void> {
  const inserted = await db
    .insertInto("notifications")
    .values({
      institution_id: n.institutionId,
      user_id: n.userId,
      type: n.type,
      title: n.title.slice(0, 300),
      body: n.body?.slice(0, 2000) ?? null,
      link: n.link ?? null,
      dedupe_key: n.dedupeKey,
    })
    .onConflict((oc) => oc.columns(["user_id", "dedupe_key"]).doNothing())
    .returning("id")
    .executeTakeFirst();
  if (inserted) await queue?.send("email-outbox", {});
}

/** Where a submission lives in the web app. */
export async function submissionLinks(db: Db, submissionId: string) {
  const row = await db
    .selectFrom("submissions as s")
    .innerJoin("assignments as a", "a.id", "s.assignment_id")
    .innerJoin("institutions as i", "i.id", "s.institution_id")
    .select(["s.institution_id", "s.user_id", "a.id as assignment_id", "a.course_id", "a.title", "i.slug"])
    .where("s.id", "=", submissionId)
    .executeTakeFirst();
  if (!row) return null;
  const assignment = `/i/${row.slug}/courses/${row.course_id}/assignments/${row.assignment_id}`;
  return { ...row, assignment, submission: `${assignment}/submissions/${submissionId}` };
}

/**
 * Reminds students whose deadline is within the next 24 hours and whose work is still open
 * (once per deadline, so an extension brings a new reminder).
 */
export async function remindDeadlines(db: Db, now = new Date(), queue?: JobQueue): Promise<number> {
  const { rows } = await sql<{ submission_id: string; due: Date }>`
    select s.id as submission_id, coalesce(x.due_at, a.due_at) as due
    from submissions s
    join assignments a on a.id = s.assignment_id
    left join assignment_extensions x on x.assignment_id = a.id and x.user_id = s.user_id
    where s.finalized_at is null and a.status = 'published'
      and coalesce(x.due_at, a.due_at) > ${now}
      and coalesce(x.due_at, a.due_at) <= ${now}::timestamptz + interval '24 hours'
    limit 1000`.execute(db);
  for (const r of rows) {
    const links = await submissionLinks(db, r.submission_id);
    if (!links) continue;
    await notify(
      db,
      {
        institutionId: links.institution_id,
        userId: links.user_id,
        type: "deadline_soon",
        title: `${links.title} is due within 24 hours`,
        body: "Push your work to the default branch before the deadline; the latest push counts.",
        link: links.assignment,
        dedupeKey: `deadline:${r.submission_id}:${new Date(r.due).getTime()}`,
      },
      queue,
    );
  }
  return rows.length;
}
