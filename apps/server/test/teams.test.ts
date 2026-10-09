import { sql } from "@hbe/db";
import { FakeGitHub } from "@hbe/github";
import type { ProcessResult } from "@hbe/core";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { recomputeGrade } from "../src/grading.ts";
import { leadSubmissionId, syncTeamAccess } from "../src/teams.ts";
import { computeSubmissionProcess, queueAutomaticRuns } from "../src/worker/activity.ts";
import { finalizeDueSubmissions } from "../src/worker/deadlines.ts";
import { provisionSubmission } from "../src/worker/provisioning.ts";
import { FakeQueue, FakeVerifier, Fixtures, randomGithubId, testDb, testSettings, unique } from "./helpers.ts";
import { sha } from "./scenario.ts";

const db = testDb();
const fixtures = new Fixtures(db);
const queue = new FakeQueue();
const verifier = new FakeVerifier();
const settings = testSettings();
const log = Fastify({ logger: false }).log;
const github = new FakeGitHub();
let app: FastifyInstance;
let org: string;
let institutionId: string;
let courseId: string;
let assignmentId: string;
let instructor: string;
let criterionId: string;
const people: Record<string, { id: string; login: string | null }> = {};
const teams: Record<string, string> = {};

const as = (userId: string) => ({ authorization: `Bearer ${verifier.tokenFor(userId)}` });
const submissionOf = (who: string) =>
  db
    .selectFrom("submissions")
    .selectAll()
    .where("assignment_id", "=", assignmentId)
    .where("user_id", "=", people[who]!.id)
    .executeTakeFirstOrThrow();
const putTeam = (who: string, teamId: string | null, actor = instructor) =>
  app.inject({
    method: "PUT",
    url: `/v1/courses/${courseId}/team-members/${people[who]!.id}`,
    headers: as(actor),
    payload: { teamId },
  });
const provision = (submissionId: string) => provisionSubmission({ db, github, queue, log }, submissionId);
const collaborators = (repo: { owner: string; name: string }) =>
  [...(github.collaborators.get(`${repo.owner}/${repo.name}`.toLowerCase())?.keys() ?? [])].sort();

beforeAll(async () => {
  app = await buildApp({ settings, db, queue, verifier, github });
  github.templates.add("hbe-templates/mern-starter");
  instructor = await fixtures.user();
  for (const name of ["ada", "grace", "linus", "nogh", "ken"]) {
    const login = name === "nogh" ? null : `${name}-${unique()}`;
    people[name] = { id: await fixtures.user(login ? { githubId: randomGithubId(), githubLogin: login } : {}), login };
  }
  const inst = await fixtures.institution([
    { userId: instructor, role: "teacher" },
    ...Object.values(people).map((p) => ({ userId: p.id, role: "student" as const })),
  ]);
  institutionId = inst.id;
  org = `org-${unique()}`;
  const installationId = randomGithubId();
  fixtures.installationIds.push(installationId);
  const gh = await db
    .insertInto("github_installations")
    .values({
      institution_id: inst.id,
      installation_id: installationId,
      account_id: 1,
      account_login: org,
      account_type: "Organization",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  courseId = (
    await db
      .insertInto("courses")
      .values({ institution_id: inst.id, code: "CS2", name: "Teams", term: "T1", github_installation_id: gh.id })
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
  await db
    .insertInto("course_memberships")
    .values([
      { institution_id: inst.id, course_id: courseId, user_id: instructor, role: "instructor" },
      ...Object.values(people).map((p) => ({
        institution_id: inst.id,
        course_id: courseId,
        user_id: p.id,
        role: "student" as const,
      })),
    ])
    .execute();
  const profileId = (
    await db.selectFrom("stack_profiles").select("id").where("key", "=", "mern-node20").executeTakeFirstOrThrow()
  ).id;
  assignmentId = (
    await db
      .insertInto("assignments")
      .values({
        institution_id: inst.id,
        course_id: courseId,
        slug: "shop",
        title: "Shop",
        mode: "team",
        stack_profile_id: profileId,
        template_repo: "hbe-templates/mern-starter",
        due_at: new Date(Date.now() + 7 * 86_400_000),
        weights: JSON.stringify({ automated: 60, rubric: 25, process: 15 }),
        late_policy: JSON.stringify({ per_day_percent: 10, max_days: 0, grace_minutes: 15 }),
        triggers: JSON.stringify({ on_push: true, on_pull_request: true, manual: true }),
        grader_suite_id: sql<string>`(select id from grader_suites where key = 'todo-api' and institution_id is null)`,
      })
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
  criterionId = (
    await db
      .insertInto("assignment_criteria")
      .values({ institution_id: inst.id, assignment_id: assignmentId, title: "Design", max_points: "10", position: 0 })
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
});

afterAll(async () => {
  await app.close();
  await fixtures.cleanup();
  await db.destroy();
});

describe("teams", () => {
  it("are formed by the course's instructors", async () => {
    const create = (name: string, actor = instructor) =>
      app.inject({ method: "POST", url: `/v1/courses/${courseId}/teams`, headers: as(actor), payload: { name } });
    expect((await create("Red", people.ada!.id)).statusCode).toBe(403);
    for (const name of ["Red", "Blue"]) {
      const res = await create(name);
      expect(res.statusCode).toBe(201);
      teams[name] = res.json().id;
    }
    expect((await create("Red")).json().slug).toBe("red-2"); // names may repeat; slugs don't
    await db.deleteFrom("teams").where("slug", "=", "red-2").execute();

    expect((await putTeam("ada", teams.Red!)).statusCode).toBe(200);
    expect((await putTeam("grace", teams.Red!)).statusCode).toBe(200);
    expect((await putTeam("linus", teams.Blue!)).statusCode).toBe(200);
    expect((await putTeam("ken", teams.Red!, people.ada!.id)).statusCode).toBe(403);
    const outsider = await fixtures.user();
    const res = await app.inject({
      method: "PUT",
      url: `/v1/courses/${courseId}/team-members/${outsider}`,
      headers: as(instructor),
      payload: { teamId: teams.Red },
    });
    expect(res.statusCode).toBe(409);
  });

  it("give each team one repository on a team assignment", async () => {
    queue.sent.length = 0;
    const published = await app.inject({
      method: "POST",
      url: `/v1/assignments/${assignmentId}/publish`,
      headers: as(instructor),
    });
    expect(published.statusCode).toBe(200);
    expect((await submissionOf("ada")).team_id).toBe(teams.Red);
    expect((await submissionOf("ken")).status).toBe("waiting_for_team");
    expect((await submissionOf("nogh")).status).toBe("waiting_for_team");

    for (const who of ["ada", "grace", "linus"]) expect(await provision((await submissionOf(who)).id)).toBe("active");
    const ada = await submissionOf("ada");
    const grace = await submissionOf("grace");
    const linus = await submissionOf("linus");
    expect(grace.repository_id).toBe(ada.repository_id);
    expect(linus.repository_id).not.toBe(ada.repository_id);
    const red = await db
      .selectFrom("repositories")
      .selectAll()
      .where("id", "=", ada.repository_id!)
      .executeTakeFirstOrThrow();
    expect(red.name).toMatch(/^shop-red-[0-9a-f]{6}$/);
    expect(collaborators(red)).toEqual([people.ada!.login, people.grace!.login].map((l) => l!.toLowerCase()).sort());
    // One template copy for the team, however many members provisioned.
    expect(github.calls.filter((c) => c.startsWith("createRepoFromTemplate") && c.includes("/shop-red-"))).toHaveLength(
      1,
    );
  });

  it("run the tests once per push, and score each member on their own commits", async () => {
    const ada = await submissionOf("ada");
    queue.sent.length = 0;
    expect(await queueAutomaticRuns({ db, queue, settings }, ada.repository_id!, "push", sha())).toBe(1);
    const runs = await db
      .selectFrom("evaluation_runs")
      .select(["submission_id", "trigger"])
      .where("submission_id", "in", [ada.id, (await submissionOf("grace")).id])
      .execute();
    expect(runs).toEqual([{ submission_id: await leadSubmissionId(db, ada.id), trigger: "push" }]);

    // Ada wrote a little; Grace most of it.
    const commit = (author: string, lines: number, daysAgo: number) => ({
      institution_id: institutionId,
      repository_id: ada.repository_id!,
      sha: sha(),
      message: "work",
      authored_at: new Date(Date.now() - daysAgo * 86_400_000),
      author_profile_id: people[author]!.id,
      details_status: "done" as const,
      parent_count: 1,
      effective_lines: lines,
    });
    await db
      .insertInto("commits")
      .values([commit("ada", 10, 3), commit("grace", 100, 3), commit("grace", 100, 2), commit("grace", 100, 1)])
      .execute();
    await computeSubmissionProcess({ db, log }, ada.id);
    const snapshot = await db
      .selectFrom("process_snapshots")
      .select("breakdown")
      .where("submission_id", "=", ada.id)
      .executeTakeFirstOrThrow();
    const result = snapshot.breakdown as unknown as ProcessResult;
    expect(result.meaningfulCommits).toBe(1);
    expect(result.unattributedCommits).toBe(0);
    expect(result.contribution).toMatchObject({ memberLines: 10, teamLines: 310, flagged: true });
  });

  it("move a student's open work to their new team's repository", async () => {
    queue.sent.length = 0;
    expect((await putTeam("grace", teams.Blue!)).json()).toMatchObject({ moved: 1, previousTeamId: teams.Red });
    const grace = await submissionOf("grace");
    expect(grace).toMatchObject({ team_id: teams.Blue, repository_id: null, status: "provisioning" });
    expect(queue.sent.map((j) => j.name).sort()).toEqual(["provision-submission", "team-access"]);
    expect(await provision(grace.id)).toBe("active");
    const linus = await submissionOf("linus");
    expect((await submissionOf("grace")).repository_id).toBe(linus.repository_id);

    await syncTeamAccess({ db, github, log }, teams.Red!);
    const red = await db
      .selectFrom("repositories")
      .selectAll()
      .where("id", "=", (await submissionOf("ada")).repository_id!)
      .executeTakeFirstOrThrow();
    expect(collaborators(red)).toEqual([people.ada!.login!.toLowerCase()]);

    // Back to Red for the rest of the story.
    await putTeam("grace", teams.Red!);
    expect(await provision((await submissionOf("grace")).id)).toBe("active");
    await syncTeamAccess({ db, github, log }, teams.Blue!);
    expect((await submissionOf("grace")).repository_id).toBe((await submissionOf("ada")).repository_id);
  });

  it("grade every member from the team's one deadline run, with the rubric scored once", async () => {
    const ada = await submissionOf("ada");
    const grace = await submissionOf("grace");
    const finalSha = sha();
    await db
      .insertInto("branch_pushes")
      .values({
        institution_id: institutionId,
        repository_id: ada.repository_id!,
        sha: finalSha,
        pushed_at: new Date(Date.now() - 3 * 3_600_000),
      })
      .execute();
    await db
      .updateTable("assignments")
      .set({ due_at: new Date(Date.now() - 2 * 3_600_000) })
      .where("id", "=", assignmentId)
      .execute();
    await finalizeDueSubmissions({ db, queue, settings, log });

    const deadlineRuns = await db
      .selectFrom("evaluation_runs")
      .select(["id", "submission_id"])
      .where("submission_id", "in", [ada.id, grace.id])
      .where("trigger", "=", "deadline")
      .execute();
    expect(deadlineRuns).toEqual([{ id: expect.any(String), submission_id: await leadSubmissionId(db, ada.id) }]);
    expect((await submissionOf("grace")).final_sha).toBe(finalSha);

    await db
      .updateTable("evaluation_runs")
      .set({ status: "completed", score: "80", finished_at: new Date() })
      .where("id", "=", deadlineRuns[0]!.id)
      .execute();
    const review = await app.inject({
      method: "PUT",
      url: `/v1/submissions/${ada.id}/review`,
      headers: as(instructor),
      payload: { scores: [{ criterionId, points: 9 }], feedback: "Good teamwork" },
    });
    expect(review.statusCode).toBe(200);
    expect(review.json().team).toBe(2);
    const graceScores = await db
      .selectFrom("rubric_scores")
      .select("points")
      .where("submission_id", "=", grace.id)
      .execute();
    expect(graceScores).toEqual([{ points: "9.00" }]);

    const graceGrade = await recomputeGrade(db, grace.id, { actorId: null });
    const components = graceGrade!.components as { automated: { score: number; runId: string } };
    expect(components.automated).toMatchObject({ score: 80, runId: deadlineRuns[0]!.id });
  });

  it("can't be deleted once they have work; empty ones can, and the rest form teams automatically", async () => {
    const del = (teamId: string) =>
      app.inject({ method: "DELETE", url: `/v1/teams/${teamId}`, headers: as(instructor) });
    expect((await del(teams.Red!)).statusCode).toBe(409);
    const empty = await app.inject({
      method: "POST",
      url: `/v1/courses/${courseId}/teams`,
      headers: as(instructor),
      payload: { name: "Spare" },
    });
    expect((await del(empty.json().id)).statusCode).toBe(200);

    const auto = await app.inject({
      method: "POST",
      url: `/v1/courses/${courseId}/teams/auto`,
      headers: as(instructor),
      payload: { size: 2 },
    });
    expect(auto.json()).toEqual({ teams: 1, students: 2 }); // ken and nogh
    const membership = await db
      .selectFrom("team_members")
      .select("team_id")
      .where("course_id", "=", courseId)
      .where("user_id", "in", [people.ken!.id, people.nogh!.id])
      .execute();
    expect(membership).toHaveLength(2);
    expect(new Set(membership.map((m) => m.team_id)).size).toBe(1);
    // The deadline has passed, so their (graded) submissions stay as they are.
    expect(await submissionOf("ken")).toMatchObject({ team_id: null, status: "missing" });
  });
});
