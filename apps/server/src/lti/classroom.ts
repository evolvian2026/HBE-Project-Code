import type { Db } from "@hbe/db";
import { gradebooksOfCourse, withClassroom, type LmsDeps } from "./gradebook.ts";
import { queueAssignmentSync } from "./grades.ts";

export interface PostResult {
  posted: number;
  already: number;
  failed: { classroom: string; error: string }[];
}

/**
 * Posts an assignment to every Google Classroom class linked to its course, as coursework the
 * platform owns (Classroom only accepts grades for coursework created by the same OAuth
 * client). The coursework links back to the assignment; released grades follow.
 */
export async function postToClassroom(deps: LmsDeps, assignmentId: string, actorId: string): Promise<PostResult> {
  const { db, settings } = deps;
  const a = await db
    .selectFrom("assignments as a")
    .innerJoin("courses as c", "c.id", "a.course_id")
    .innerJoin("institutions as i", "i.id", "a.institution_id")
    .select([
      "a.id",
      "a.title",
      "a.due_at",
      "a.course_id",
      "a.institution_id",
      "a.status",
      "c.name as course_name",
      "i.slug",
    ])
    .where("a.id", "=", assignmentId)
    .executeTakeFirstOrThrow();
  const result: PostResult = { posted: 0, already: 0, failed: [] };
  const books = (await gradebooksOfCourse(deps, a.course_id)).filter((b) => b.kind === "classroom");
  for (const book of books) {
    const link = await db
      .selectFrom("lms_course_links")
      .select(["context_id", "context_title", "google_account_id"])
      .where("id", "=", book.linkId)
      .executeTakeFirstOrThrow();
    const existing = await db
      .selectFrom("lms_assignment_links")
      .select("classroom_coursework_id")
      .where("lms_course_link_id", "=", book.linkId)
      .where("assignment_id", "=", a.id)
      .executeTakeFirst();
    if (existing?.classroom_coursework_id) {
      result.already++;
      continue;
    }
    const url = `${settings.env.APP_URL}/i/${a.slug}/courses/${a.course_id}/assignments/${a.id}`;
    try {
      const work = await withClassroom(deps, link.google_account_id, (c) =>
        c.createCourseWork(link.context_id, {
          title: a.title,
          description: `Work on this assignment in HBE Projects: ${url}\nYour grade is posted here when your teacher releases it.`,
          link: url,
          maxPoints: 100,
          due: new Date(a.due_at),
        }),
      );
      await db
        .insertInto("lms_assignment_links")
        .values({
          institution_id: a.institution_id,
          assignment_id: a.id,
          lms_course_link_id: book.linkId,
          classroom_coursework_id: work.id,
          classroom_link: work.alternateLink,
          score_maximum: "100",
          created_by: actorId,
        })
        .onConflict((oc) =>
          oc.columns(["lms_course_link_id", "assignment_id"]).doUpdateSet({
            classroom_coursework_id: work.id,
            classroom_link: work.alternateLink,
            score_maximum: "100",
          }),
        )
        .execute();
      result.posted++;
    } catch (err) {
      result.failed.push({
        classroom: link.context_title ?? link.context_id,
        error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
      });
    }
  }
  if (result.posted && deps.queue) await queueAssignmentSync(db, deps.queue, a.id);
  return result;
}

/** The Google Classroom connection of an institution, if an admin turned it on. */
export async function classroomConnection(db: Db, institutionId: string) {
  return db
    .selectFrom("lms_connections")
    .select(["id", "status"])
    .where("institution_id", "=", institutionId)
    .where("type", "=", "google_classroom")
    .executeTakeFirst();
}
