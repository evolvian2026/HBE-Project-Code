import { authorize } from "@hbe/core";
import type { GitHubClient } from "@hbe/github";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiDeps } from "../app.ts";
import { authenticate } from "../auth.ts";
import { conflict, notFound } from "../errors.ts";
import { postFeedback } from "../worker/feedback.ts";
import { courseRoleOf } from "./lms.ts";

/**
 * Course staff post a submission's released feedback to its repository's GitHub "Feedback"
 * issue now, instead of waiting for the worker (e.g. after deleting a code comment).
 */
export async function githubFeedbackRoutes(app: FastifyInstance, deps: ApiDeps & { github: GitHubClient }) {
  const { db, verifier } = deps;

  app.post<{ Params: { submissionId: string } }>("/v1/submissions/:submissionId/github-feedback", async (req) => {
    const actor = await authenticate(req, db, verifier);
    const s = await db
      .selectFrom("submissions as s")
      .innerJoin("assignments as a", "a.id", "s.assignment_id")
      .select([
        "s.institution_id",
        "s.repository_id",
        "s.grade_released_at",
        "a.course_id",
        "a.post_feedback_to_github",
      ])
      .where("s.id", "=", z.string().uuid().parse(req.params.submissionId))
      .executeTakeFirst();
    if (!s) throw notFound("Submission not found");
    authorize(actor, "actAsCourseStaff", s.institution_id, await courseRoleOf(db, s.course_id, actor.userId));
    if (!s.post_feedback_to_github) {
      throw conflict("not_enabled", "This assignment doesn't post feedback to GitHub. Turn it on in its settings.");
    }
    if (!s.repository_id) throw conflict("no_repository", "This submission has no repository.");
    if (!s.grade_released_at) throw conflict("not_released", "Feedback goes to GitHub once the grade is released.");
    const result = await postFeedback({ ...deps, log: req.log }, s.repository_id);
    const repo = await db
      .selectFrom("repositories")
      .select(["owner", "name", "feedback_issue_number", "feedback_error"])
      .where("id", "=", s.repository_id)
      .executeTakeFirstOrThrow();
    return {
      result,
      issueUrl: repo.feedback_issue_number
        ? `https://github.com/${repo.owner}/${repo.name}/issues/${repo.feedback_issue_number}`
        : null,
      error: repo.feedback_error,
    };
  });
}
