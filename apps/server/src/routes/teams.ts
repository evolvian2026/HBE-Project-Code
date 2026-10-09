import { randomInt } from "node:crypto";
import { authorize, slugify } from "@hbe/core";
import { withActor, type Db } from "@hbe/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiDeps } from "../app.ts";
import { authenticate } from "../auth.ts";
import { conflict, notFound } from "../errors.ts";
import { setStudentTeam } from "../teams.ts";
import { courseRoleOf } from "./lms.ts";

const uuid = z.string().uuid();
const MAX_TEAM_SIZE = 12;

/** A slug for a team's name that no other team in the course has (repository names use it). */
async function freeSlug(db: Db, courseId: string, name: string): Promise<string> {
  const base = (slugify(name) || "team").slice(0, 34).replace(/-+$/, "");
  const taken = new Set(
    (await db.selectFrom("teams").select("slug").where("course_id", "=", courseId).execute()).map((t) => t.slug),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/**
 * Teams within a course (§5.2). Instructors (and admins) manage them through the api, because
 * moving a student moves their open team-assignment work to the new team's repository.
 */
export async function teamRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const { db, verifier, queue } = deps;

  const courseFor = async (courseId: string) => {
    const course = await db
      .selectFrom("courses")
      .select(["id", "institution_id", "archived_at"])
      .where("id", "=", uuid.parse(courseId))
      .executeTakeFirst();
    if (!course) throw notFound("Course not found");
    return course;
  };
  const manage = async (req: Parameters<typeof authenticate>[0], course: { id: string; institution_id: string }) => {
    const actor = await authenticate(req, db, verifier);
    authorize(actor, "manageCourse", course.institution_id, await courseRoleOf(db, course.id, actor.userId));
    return actor;
  };
  const teamFor = async (teamId: string) => {
    const team = await db
      .selectFrom("teams")
      .select(["id", "institution_id", "course_id", "name"])
      .where("id", "=", uuid.parse(teamId))
      .executeTakeFirst();
    if (!team) throw notFound("Team not found");
    return team;
  };
  const name = z.string().trim().min(1, "Give the team a name.").max(80);

  app.post<{ Params: { courseId: string } }>("/v1/courses/:courseId/teams", async (req, reply) => {
    const course = await courseFor(req.params.courseId);
    const actor = await manage(req, course);
    const body = z.object({ name }).parse(req.body);
    const team = await withActor(db, actor.userId, async (tx) =>
      tx
        .insertInto("teams")
        .values({
          institution_id: course.institution_id,
          course_id: course.id,
          name: body.name,
          slug: await freeSlug(tx, course.id, body.name),
          created_by: actor.userId,
        })
        .returning(["id", "slug"])
        .executeTakeFirstOrThrow(),
    );
    return reply.code(201).send(team);
  });

  /** Renames a team (its repositories keep their names). */
  app.patch<{ Params: { teamId: string } }>("/v1/teams/:teamId", async (req) => {
    const team = await teamFor(req.params.teamId);
    const actor = await manage(req, { id: team.course_id, institution_id: team.institution_id });
    const body = z.object({ name }).parse(req.body);
    await withActor(db, actor.userId, (tx) =>
      tx.updateTable("teams").set({ name: body.name }).where("id", "=", team.id).execute(),
    );
    return { id: team.id };
  });

  /** Deletes a team that has no work on a team assignment yet. */
  app.delete<{ Params: { teamId: string } }>("/v1/teams/:teamId", async (req) => {
    const team = await teamFor(req.params.teamId);
    const actor = await manage(req, { id: team.course_id, institution_id: team.institution_id });
    const work = await db.selectFrom("submissions").select("id").where("team_id", "=", team.id).executeTakeFirst();
    if (work) {
      throw conflict(
        "team_has_work",
        "This team has work on a team assignment, so it can't be deleted. Move its members instead.",
      );
    }
    await withActor(db, actor.userId, (tx) => tx.deleteFrom("teams").where("id", "=", team.id).execute());
    return { deleted: true };
  });

  /** Puts a student of the course in a team, or (`teamId: null`) takes them out of theirs. */
  app.put<{ Params: { courseId: string; userId: string } }>(
    "/v1/courses/:courseId/team-members/:userId",
    async (req) => {
      const course = await courseFor(req.params.courseId);
      const actor = await manage(req, course);
      const userId = uuid.parse(req.params.userId);
      const { teamId } = z.object({ teamId: uuid.nullable() }).parse(req.body);
      const student = await db
        .selectFrom("course_memberships")
        .select("id")
        .where("course_id", "=", course.id)
        .where("user_id", "=", userId)
        .where("role", "=", "student")
        .executeTakeFirst();
      if (!student) throw conflict("not_a_student", "Only students of this course can be in its teams.");
      if (teamId) {
        const team = await teamFor(teamId);
        if (team.course_id !== course.id) throw notFound("Team not found");
        const size = await db
          .selectFrom("team_members")
          .select((eb) => eb.fn.countAll<number>().as("n"))
          .where("team_id", "=", team.id)
          .executeTakeFirstOrThrow();
        if (Number(size.n) >= MAX_TEAM_SIZE)
          throw conflict("team_full", `A team has at most ${MAX_TEAM_SIZE} members.`);
      }
      return setStudentTeam(
        { db, queue },
        { institutionId: course.institution_id, courseId: course.id, userId, teamId, actorId: actor.userId },
      );
    },
  );

  /** Puts every student without a team into new teams of `size` (at random). */
  app.post<{ Params: { courseId: string } }>("/v1/courses/:courseId/teams/auto", async (req, reply) => {
    const course = await courseFor(req.params.courseId);
    const actor = await manage(req, course);
    const { size } = z.object({ size: z.number().int().min(2).max(MAX_TEAM_SIZE) }).parse(req.body);
    const unteamed = (
      await db
        .selectFrom("course_memberships as cm")
        .innerJoin("institution_memberships as im", (j) =>
          j.onRef("im.institution_id", "=", "cm.institution_id").onRef("im.user_id", "=", "cm.user_id"),
        )
        .select("cm.user_id")
        .where("cm.course_id", "=", course.id)
        .where("cm.role", "=", "student")
        .where("im.status", "=", "active")
        .where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom("team_members as tm")
                .select("tm.id")
                .whereRef("tm.user_id", "=", "cm.user_id")
                .where("tm.course_id", "=", course.id),
            ),
          ),
        )
        .execute()
    ).map((r) => r.user_id);
    // Fisher–Yates shuffle, then groups of `size`; a short last group joins the others.
    for (let i = unteamed.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [unteamed[i], unteamed[j]] = [unteamed[j]!, unteamed[i]!];
    }
    const groups: string[][] = [];
    for (let i = 0; i < unteamed.length; i += size) groups.push(unteamed.slice(i, i + size));
    if (groups.length > 1 && groups.at(-1)!.length < Math.ceil(size / 2)) {
      const last = groups.pop()!;
      last.forEach((u, i) => groups[i % groups.length]!.push(u));
    }
    const existing = await db.selectFrom("teams").select("name").where("course_id", "=", course.id).execute();
    let n = existing.length;
    const names = new Set(existing.map((t) => t.name));
    let created = 0;
    for (const group of groups) {
      let teamName: string;
      do teamName = `Team ${++n}`;
      while (names.has(teamName));
      const team = await withActor(db, actor.userId, async (tx) =>
        tx
          .insertInto("teams")
          .values({
            institution_id: course.institution_id,
            course_id: course.id,
            name: teamName,
            slug: await freeSlug(tx, course.id, teamName),
            created_by: actor.userId,
          })
          .returning("id")
          .executeTakeFirstOrThrow(),
      );
      created++;
      for (const userId of group) {
        await setStudentTeam(
          { db, queue },
          { institutionId: course.institution_id, courseId: course.id, userId, teamId: team.id, actorId: actor.userId },
        );
      }
    }
    return reply.code(201).send({ teams: created, students: unteamed.length });
  });
}
