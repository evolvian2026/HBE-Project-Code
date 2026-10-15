import { createHash } from "node:crypto";
import { sql, type Db } from "@hbe/db";
import { GitHubError, type GitHubClient } from "@hbe/github";
import type { JobQueue } from "@hbe/queue";
import type { Settings } from "@hbe/settings";
import type { FastifyBaseLogger } from "fastify";
import { institutionAddresses } from "../domains.ts";

export interface FeedbackDeps {
  db: Db;
  github: GitHubClient;
  settings: Settings;
  log: FastifyBaseLogger;
}

/** GitHub's issue body limit is 65,536 characters. */
const MAX_BODY = 60_000;
const MARKER = "<!-- hbe-feedback: kept up to date by the platform -->";

const quote = (text: string) =>
  text
    .trim()
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/**
 * The repository's released feedback as a GitHub issue: the written feedback, and each inline
 * code comment as a permalink (GitHub shows it as a snippet of the code) followed by the
 * comment. Never the scores. `off` when the assignment doesn't post feedback or nothing is
 * released yet; `empty` when there is nothing to say.
 */
export async function composeFeedback(
  db: Db,
  /** The institution's address (its own domain when it has one). */
  addressOf: (slug: string) => Promise<string>,
  repositoryId: string,
): Promise<{ status: "off" } | { status: "empty" } | { status: "ready"; title: string; body: string }> {
  const subs = await db
    .selectFrom("submissions as s")
    .innerJoin("assignments as a", "a.id", "s.assignment_id")
    .innerJoin("institutions as i", "i.id", "s.institution_id")
    .innerJoin("repositories as r", "r.id", "s.repository_id")
    .select([
      "s.id",
      "s.grade_released_at",
      "a.id as assignment_id",
      "a.course_id",
      "a.title",
      "a.post_feedback_to_github",
      "i.slug",
      "r.owner",
      "r.name",
    ])
    .where("s.repository_id", "=", repositoryId)
    .orderBy("s.created_at")
    .orderBy("s.id")
    .execute();
  const first = subs[0];
  if (!first?.post_feedback_to_github) return { status: "off" };
  const released = subs.filter((s) => s.grade_released_at);
  if (!released.length) return { status: "off" };

  // A team's feedback is written once (each member has a copy); comments are on any member's.
  const feedback = await db
    .selectFrom("feedback")
    .select(["submission_id", "body_md"])
    .where(
      "submission_id",
      "in",
      released.map((s) => s.id),
    )
    .execute();
  const written =
    released.map((s) => feedback.find((f) => f.submission_id === s.id)?.body_md.trim()).find(Boolean) ?? "";
  const comments = await db
    .selectFrom("review_comments")
    .select(["sha", "path", "line", "body"])
    .where(
      "submission_id",
      "in",
      released.map((s) => s.id),
    )
    .orderBy("path")
    .orderBy("line")
    .orderBy("created_at")
    .execute();
  if (!written && !comments.length) return { status: "empty" };

  const link = new URL(
    `/i/${first.slug}/courses/${first.course_id}/assignments/${first.assignment_id}`,
    await addressOf(first.slug),
  );
  const parts = [
    MARKER,
    `Feedback on **${first.title}** from your course staff. Your grade and its breakdown are on the platform: ${link}`,
  ];
  if (written) parts.push("## Feedback", written);
  if (comments.length) {
    parts.push(`## Comments on your code (${comments.length})`);
    for (const c of comments) {
      parts.push(
        `**\`${c.path}\` line ${c.line}**\n\nhttps://github.com/${first.owner}/${first.name}/blob/${c.sha}/${encodePath(c.path)}#L${c.line}\n\n${quote(c.body)}`,
      );
    }
  }
  let body = parts.join("\n\n");
  if (body.length > MAX_BODY) body = `${body.slice(0, MAX_BODY)}\n\n…the rest is on the platform: ${link}`;
  return { status: "ready", title: `Feedback: ${first.title}`.slice(0, 250), body };
}

export type FeedbackResult = "posted" | "unchanged" | "nothing" | "off" | "failed";

/**
 * Posts (or updates) the repository's "Feedback" issue. Each attempt is stamped
 * (`feedback_posted_at`), so the sweep only comes back when something changes; a GitHub
 * refusal is kept in `feedback_error` for staff to see.
 */
export async function postFeedback(deps: FeedbackDeps, repositoryId: string): Promise<FeedbackResult> {
  const { db, github, settings, log } = deps;
  return db.transaction().execute(async (tx) => {
    // One post at a time per repository (the job and a staff request can meet).
    const repo = await tx
      .selectFrom("repositories as r")
      .innerJoin("github_installations as g", "g.id", "r.github_installation_id")
      .select(["r.id", "r.owner", "r.name", "r.feedback_issue_number", "r.feedback_hash", "g.installation_id"])
      .where("r.id", "=", repositoryId)
      .forUpdate("r")
      .executeTakeFirst();
    if (!repo) return "off";
    const composed = await composeFeedback(tx, institutionAddresses(tx, settings).forSlug, repositoryId);
    if (composed.status === "off") return "off";
    const stamp = (values: { feedback_issue_number?: number; feedback_hash?: string; feedback_error: string | null }) =>
      tx
        .updateTable("repositories")
        .set({ ...values, feedback_posted_at: new Date() })
        .where("id", "=", repositoryId)
        .execute();
    if (composed.status === "empty") {
      await stamp({ feedback_error: null });
      return "nothing";
    }
    const content = { title: composed.title, body: composed.body };
    const hash = createHash("sha256").update(`${content.title}\n${content.body}`).digest("hex");
    if (repo.feedback_issue_number && repo.feedback_hash === hash) {
      await stamp({ feedback_error: null });
      return "unchanged";
    }
    const gh = github.forInstallation(repo.installation_id);
    try {
      let number = repo.feedback_issue_number;
      if (number) {
        try {
          await gh.updateIssue(repo.owner, repo.name, number, content);
        } catch (err) {
          // Deleted (or transferred) on GitHub: open a new one.
          if (!(err instanceof GitHubError && (err.status === 404 || err.status === 410))) throw err;
          number = null;
        }
      }
      number ??= await gh.createIssue(repo.owner, repo.name, content);
      await stamp({ feedback_issue_number: number, feedback_hash: hash, feedback_error: null });
      log.info({ repositoryId, issue: number }, "feedback posted to GitHub");
      return "posted";
    } catch (err) {
      if (err instanceof GitHubError && !err.retryable) {
        await stamp({ feedback_error: `GitHub refused the feedback issue: ${err.message}`.slice(0, 1000) });
        log.warn({ repositoryId, err: err.message }, "could not post feedback to GitHub");
        return "failed";
      }
      throw err;
    }
  });
}

/** Queues a feedback post for the repositories of these submissions (after their grades are released). */
export async function queueFeedbackPosts(db: Db, queue: JobQueue, submissionIds: string[]): Promise<void> {
  if (!submissionIds.length) return;
  const repos = await db
    .selectFrom("submissions as s")
    .innerJoin("assignments as a", "a.id", "s.assignment_id")
    .select("s.repository_id")
    .distinct()
    .where("s.id", "in", submissionIds)
    .where("a.post_feedback_to_github", "=", true)
    .where("s.repository_id", "is not", null)
    .execute();
  for (const { repository_id } of repos) {
    await queue.send("post-feedback", { repositoryId: repository_id! }, { singletonKey: `feedback-${repository_id}` });
  }
}

/**
 * Repositories whose released feedback changed since it was last posted (or never was): a
 * grade released, written feedback or a code comment saved since. (A deleted comment shows
 * on GitHub with the next change, or when staff post again.)
 */
export async function sweepFeedback(deps: { db: Db; queue: JobQueue }): Promise<number> {
  const { rows } = await sql<{ id: string }>`
    select distinct r.id from repositories r
    join submissions s on s.repository_id = r.id
    join assignments a on a.id = s.assignment_id
    where a.post_feedback_to_github and s.grade_released_at is not null
      and (r.feedback_posted_at is null
           or s.grade_released_at > r.feedback_posted_at
           or exists (select 1 from feedback f where f.submission_id = s.id and f.updated_at > r.feedback_posted_at)
           or exists (select 1 from review_comments c where c.submission_id = s.id and c.updated_at > r.feedback_posted_at))
    limit 500`.execute(deps.db);
  for (const { id } of rows) {
    await deps.queue.send("post-feedback", { repositoryId: id }, { singletonKey: `feedback-${id}` });
  }
  return rows.length;
}
