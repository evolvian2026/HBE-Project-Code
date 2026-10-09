import { sql, type Db } from "@hbe/db";
import type { GitHubClient } from "@hbe/github";
import type { JobQueue } from "@hbe/queue";
import type { FastifyBaseLogger } from "fastify";

/**
 * Team assignments (docs/ARCHITECTURE.md §5.2): each member has their own submission, and the
 * members' submissions share the team's repository. Work on the repository (test runs, the
 * graded commit, snapshots, the rubric) is the team's; grades stay per member.
 */

/** The submissions of a submission's team on its assignment (itself included); itself alone for individual work. */
export async function teamSubmissionIds(db: Db, submissionId: string): Promise<string[]> {
  const s = await db
    .selectFrom("submissions")
    .select(["id", "assignment_id", "team_id"])
    .where("id", "=", submissionId)
    .executeTakeFirst();
  if (!s) return [];
  if (!s.team_id) return [s.id];
  const rows = await db
    .selectFrom("submissions")
    .select("id")
    .where("assignment_id", "=", s.assignment_id)
    .where("team_id", "=", s.team_id)
    .orderBy("created_at")
    .orderBy("id")
    .execute();
  return rows.map((r) => r.id);
}

/**
 * The submission that owns the team's shared runs (pushes, pull requests, the deadline run):
 * the earliest of the members' submissions on the team's repository. For individual work,
 * the submission itself.
 */
export async function leadSubmissionId(db: Db, submissionId: string): Promise<string> {
  const s = await db
    .selectFrom("submissions")
    .select(["id", "assignment_id", "team_id", "repository_id"])
    .where("id", "=", submissionId)
    .executeTakeFirstOrThrow();
  if (!s.team_id || !s.repository_id) return s.id;
  const lead = await db
    .selectFrom("submissions")
    .select("id")
    .where("assignment_id", "=", s.assignment_id)
    .where("team_id", "=", s.team_id)
    .where("repository_id", "=", s.repository_id)
    .orderBy("created_at")
    .orderBy("id")
    .executeTakeFirst();
  return lead?.id ?? s.id;
}

/**
 * Makes the GitHub access of a team's repositories match the team: every member whose
 * submission uses the repository is a collaborator, and nobody else directly is (someone moved
 * to another team loses access). Graded (finalized) submissions keep their repository.
 */
export async function syncTeamAccess(
  deps: { db: Db; github: GitHubClient; log: FastifyBaseLogger },
  teamId: string,
): Promise<{ added: number; removed: number }> {
  const { db, github, log } = deps;
  const repos = await db
    .selectFrom("repositories as r")
    .innerJoin("github_installations as g", "g.id", "r.github_installation_id")
    .select(["r.id", "r.owner", "r.name", "g.installation_id"])
    .where(({ exists, selectFrom }) =>
      exists(
        selectFrom("submissions as s")
          .select("s.id")
          .whereRef("s.repository_id", "=", "r.id")
          .where("s.team_id", "=", teamId),
      ),
    )
    .execute();
  let added = 0;
  let removed = 0;
  for (const repo of repos) {
    const members = await db
      .selectFrom("submissions as s")
      .innerJoin("profiles as p", "p.id", "s.user_id")
      .select("p.github_login")
      .where("s.repository_id", "=", repo.id)
      .execute();
    const wanted = new Set(members.flatMap((m) => (m.github_login ? [m.github_login.toLowerCase()] : [])));
    const gh = github.forInstallation(repo.installation_id);
    const current = new Set((await gh.listCollaborators(repo.owner, repo.name)).map((l) => l.toLowerCase()));
    for (const login of wanted) {
      if (!current.has(login)) {
        await gh.addCollaborator(repo.owner, repo.name, login, "push");
        added++;
      }
    }
    for (const login of current) {
      if (!wanted.has(login)) {
        await gh.removeCollaborator(repo.owner, repo.name, login);
        removed++;
      }
    }
  }
  if (added || removed) log.info({ teamId, added, removed }, "team repository access updated");
  return { added, removed };
}

/**
 * Puts a student in a team (or takes them out: `teamId` null) and moves their open
 * submissions on the course's published team assignments along: they lose the old team's
 * repository and get the new one's. Graded submissions stay where they are.
 */
export async function setStudentTeam(
  deps: { db: Db; queue: JobQueue },
  input: { institutionId: string; courseId: string; userId: string; teamId: string | null; actorId: string },
): Promise<{ moved: number; previousTeamId: string | null }> {
  const { db, queue } = deps;
  const { previousTeamId, moved } = await db.transaction().execute(async (tx) => {
    await sql`select set_config('hbe.actor_id', ${input.actorId}, true)`.execute(tx);
    const previous = await tx
      .selectFrom("team_members")
      .select("team_id")
      .where("course_id", "=", input.courseId)
      .where("user_id", "=", input.userId)
      .executeTakeFirst();
    if ((previous?.team_id ?? null) === input.teamId) return { previousTeamId: previous?.team_id ?? null, moved: [] };
    await tx
      .deleteFrom("team_members")
      .where("course_id", "=", input.courseId)
      .where("user_id", "=", input.userId)
      .execute();
    if (input.teamId) {
      await tx
        .insertInto("team_members")
        .values({
          institution_id: input.institutionId,
          course_id: input.courseId,
          team_id: input.teamId,
          user_id: input.userId,
        })
        .execute();
    }
    const profile = await tx
      .selectFrom("profiles")
      .select("github_user_id")
      .where("id", "=", input.userId)
      .executeTakeFirstOrThrow();
    const status = !input.teamId ? "waiting_for_team" : profile.github_user_id ? "provisioning" : "waiting_for_github";
    const moved = await tx
      .updateTable("submissions")
      .set({ team_id: input.teamId, repository_id: null, status, status_detail: null, provisioning_attempts: 0 })
      .where("user_id", "=", input.userId)
      .where("finalized_at", "is", null)
      .where(({ exists, selectFrom }) =>
        exists(
          selectFrom("assignments as a")
            .select("a.id")
            .whereRef("a.id", "=", "submissions.assignment_id")
            .where("a.course_id", "=", input.courseId)
            .where("a.mode", "=", "team")
            .where("a.status", "=", "published"),
        ),
      )
      .returning(["id", "status"])
      .execute();
    return { previousTeamId: previous?.team_id ?? null, moved };
  });
  for (const s of moved) {
    if (s.status === "provisioning") {
      await queue.send("provision-submission", { submissionId: s.id }, { singletonKey: `provision-${s.id}` });
    }
  }
  if (previousTeamId && moved.length) {
    await queue.send("team-access", { teamId: previousTeamId }, { singletonKey: `team-access-${previousTeamId}` });
  }
  return { moved: moved.length, previousTeamId };
}
