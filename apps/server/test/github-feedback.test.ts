import { FakeGitHub, GitHubError } from "@hbe/github";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { postFeedback, sweepFeedback } from "../src/worker/feedback.ts";
import { FakeQueue, FakeVerifier, Fixtures, testDb, testSettings } from "./helpers.ts";
import { createGradedScenario, sha, type GradedScenario } from "./scenario.ts";

const db = testDb();
const fixtures = new Fixtures(db);
const verifier = new FakeVerifier();
const settings = testSettings();
const github = new FakeGitHub();
const queue = new FakeQueue();
const log = Fastify({ logger: false }).log;
const deps = { db, github, settings, log };
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ settings, db, queue, verifier, github });
});
afterAll(async () => {
  await app.close();
  await fixtures.cleanup();
  await db.destroy();
});

const as = (userId: string) => ({ authorization: `Bearer ${verifier.tokenFor(userId)}` });
const issuesOf = (s: GradedScenario) => github.issues.get(`${s.owner}/${s.name}`.toLowerCase()) ?? [];
const repoOf = (s: GradedScenario) =>
  db.selectFrom("repositories").selectAll().where("id", "=", s.repositoryId).executeTakeFirstOrThrow();
const optIn = (s: GradedScenario) =>
  db.updateTable("assignments").set({ post_feedback_to_github: true }).where("id", "=", s.assignmentId).execute();
const comment = (s: GradedScenario, path: string, line: number, body: string, commit = sha()) =>
  db
    .insertInto("review_comments")
    .values({ institution_id: s.institutionId, submission_id: s.submissionId, sha: commit, path, line, body })
    .returning("id")
    .executeTakeFirstOrThrow();

/** Scores the rubric and writes feedback as the instructor, then releases the grade. */
async function gradeAndRelease(s: GradedScenario, feedback: string) {
  const review = await app.inject({
    method: "PUT",
    url: `/v1/submissions/${s.submissionId}/review`,
    headers: as(s.instructor),
    payload: {
      feedback,
      scores: [
        { criterionId: s.criteria[0], points: 8 },
        { criterionId: s.criteria[1], points: 7 },
      ],
    },
  });
  expect(review.statusCode).toBe(200);
  const released = await app.inject({
    method: "POST",
    url: `/v1/assignments/${s.assignmentId}/release`,
    headers: as(s.instructor),
    payload: {},
  });
  expect(released.json()).toMatchObject({ released: 1 });
}

describe("feedback on GitHub", () => {
  it("is posted as an issue once the grade is released, when the assignment opts in", async () => {
    const s = await createGradedScenario(db, fixtures, settings);
    const commit = sha();
    await comment(s, "backend/src/routes.js", 12, "Validate the title here.\nAn empty one is accepted.", commit);
    expect(await postFeedback(deps, s.repositoryId)).toBe("off"); // not opted in
    await optIn(s);
    expect(await postFeedback(deps, s.repositoryId)).toBe("off"); // not released

    queue.sent.length = 0;
    await gradeAndRelease(s, "Solid API. Add input validation next time.");
    expect(queue.sent).toContainEqual({
      name: "post-feedback",
      data: { repositoryId: s.repositoryId },
      options: { singletonKey: `feedback-${s.repositoryId}` },
    });

    expect(await postFeedback(deps, s.repositoryId)).toBe("posted");
    const [issue] = issuesOf(s);
    expect(issue!.title).toBe("Feedback: Todo");
    expect(issue!.body).toContain("Solid API. Add input validation next time.");
    expect(issue!.body).toContain(
      `https://github.com/${s.owner}/${s.name}/blob/${commit}/backend/src/routes.js#L12\n\n> Validate the title here.\n> An empty one is accepted.`,
    );
    expect(issue!.body).toContain(`/i/${s.slug}/courses/${s.courseId}/assignments/${s.assignmentId}`);
    expect(issue!.body).not.toMatch(/\b(score|points|grade:)\b/i); // never the marks
    expect(await repoOf(s)).toMatchObject({ feedback_issue_number: 1, feedback_error: null });

    // Nothing changed: GitHub isn't called again.
    github.calls.length = 0;
    expect(await postFeedback(deps, s.repositoryId)).toBe("unchanged");
    expect(github.calls).toEqual([]);
    expect(await sweepFeedback({ db, queue })).toBe(0);

    // A later comment is picked up by the sweep, and the issue is updated in place.
    await new Promise((r) => setTimeout(r, 5));
    await comment(s, "README.md", 1, "Explain how to run it.");
    queue.sent.length = 0;
    expect(await sweepFeedback({ db, queue })).toBeGreaterThanOrEqual(1);
    expect(queue.sent).toContainEqual(expect.objectContaining({ data: { repositoryId: s.repositoryId } }));
    expect(await postFeedback(deps, s.repositoryId)).toBe("posted");
    expect(github.calls).toContain(`updateIssue ${s.owner}/${s.name}#1`);
    expect(issuesOf(s)).toHaveLength(1);
    expect(issuesOf(s)[0]!.body).toContain("Explain how to run it.");

    // Deleted on GitHub: a new issue is opened.
    github.issues.set(`${s.owner}/${s.name}`.toLowerCase(), []);
    await db.updateTable("repositories").set({ feedback_hash: null }).where("id", "=", s.repositoryId).execute();
    expect(await postFeedback(deps, s.repositoryId)).toBe("posted");
    expect(issuesOf(s)).toHaveLength(1);
  });

  it("keeps GitHub's refusal for staff to see, and staff can post again", async () => {
    const s = await createGradedScenario(db, fixtures, settings);
    await optIn(s);
    await gradeAndRelease(s, "Good work.");
    github.failures.push(new GitHubError(410, "Issues are disabled for this repo", false));
    expect(await postFeedback(deps, s.repositoryId)).toBe("failed");
    expect((await repoOf(s)).feedback_error).toMatch(/Issues are disabled/);
    // Not retried by the sweep until something changes.
    queue.sent.length = 0;
    await sweepFeedback({ db, queue });
    expect(queue.sent.filter((j) => (j.data as { repositoryId?: string }).repositoryId === s.repositoryId)).toEqual([]);

    const post = (userId: string) =>
      app.inject({ method: "POST", url: `/v1/submissions/${s.submissionId}/github-feedback`, headers: as(userId) });
    expect((await post(s.student)).statusCode).toBe(403);
    const res = await post(s.ta);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      result: "posted",
      issueUrl: `https://github.com/${s.owner}/${s.name}/issues/1`,
      error: null,
    });
  });

  it("can't be posted for an assignment that doesn't opt in", async () => {
    const s = await createGradedScenario(db, fixtures, settings);
    const res = await app.inject({
      method: "POST",
      url: `/v1/submissions/${s.submissionId}/github-feedback`,
      headers: as(s.instructor),
    });
    expect(res.json()).toMatchObject({ error: "not_enabled" });
  });
});
