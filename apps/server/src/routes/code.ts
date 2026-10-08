import { allowed, ForbiddenError } from "@hbe/core";
import type { Db } from "@hbe/db";
import type { CommitTree, GitHubClient } from "@hbe/github";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiDeps } from "../app.ts";
import type { Actor } from "@hbe/core";
import { authenticate } from "../auth.ts";
import { HttpError, notFound } from "../errors.ts";

const SHA = /^[0-9a-f]{40}$/;
const MAX_FILE_BYTES = 1024 * 1024;

/** A commit's tree never changes, so trees are cached by commit (bounded). */
const treeCache = new Map<string, CommitTree>();
function remember(key: string, tree: CommitTree): CommitTree {
  treeCache.set(key, tree);
  if (treeCache.size > 100) treeCache.delete(treeCache.keys().next().value!);
  return tree;
}

/** The submission's repository, for course staff only. */
async function reviewTarget(db: Db, actor: Actor, submissionId: string) {
  const s = await db
    .selectFrom("submissions as s")
    .innerJoin("assignments as a", "a.id", "s.assignment_id")
    .leftJoin("repositories as r", "r.id", "s.repository_id")
    .leftJoin("github_installations as g", "g.id", "r.github_installation_id")
    .select([
      "s.id",
      "s.institution_id",
      "s.final_sha",
      "a.course_id",
      "r.id as repository_id",
      "r.owner",
      "r.name",
      "r.head_sha",
      "r.start_sha",
      "g.installation_id",
    ])
    .where("s.id", "=", z.string().uuid().parse(submissionId))
    .executeTakeFirst();
  if (!s) throw notFound("Submission not found");
  const role = (
    await db
      .selectFrom("course_memberships")
      .select("role")
      .where("course_id", "=", s.course_id)
      .where("user_id", "=", actor.userId)
      .executeTakeFirst()
  )?.role;
  if (!allowed(actor, "actAsCourseStaff", s.institution_id, role ?? null)) throw new ForbiddenError();
  if (!s.repository_id || !s.owner || !s.name || !s.installation_id) {
    throw new HttpError(409, "no_repository", "This submission has no repository yet.");
  }
  return { ...s, owner: s.owner, name: s.name, installationId: s.installation_id, repositoryId: s.repository_id };
}

export async function codeRoutes(app: FastifyInstance, deps: ApiDeps & { github: GitHubClient }): Promise<void> {
  const { db, verifier, github } = deps;
  const query = z.object({ sha: z.string().regex(SHA).optional(), path: z.string().min(1).max(1000).optional() });

  async function treeOf(t: Awaited<ReturnType<typeof reviewTarget>>, sha: string) {
    const key = `${t.installationId}:${t.owner}/${t.name}@${sha}`;
    return (
      treeCache.get(key) ?? remember(key, await github.forInstallation(t.installationId).getTree(t.owner, t.name, sha))
    );
  }
  const defaultSha = (t: Awaited<ReturnType<typeof reviewTarget>>, sha?: string) => {
    const resolved = sha ?? t.final_sha ?? t.head_sha;
    if (!resolved) throw new HttpError(409, "no_commits", "Nothing has been pushed yet.");
    return resolved;
  };

  /** Files and folders at a commit (the graded commit, or the latest push, by default). */
  app.get<{ Params: { submissionId: string } }>("/v1/submissions/:submissionId/code/tree", async (req) => {
    const actor = await authenticate(req, db, verifier);
    const t = await reviewTarget(db, actor, req.params.submissionId);
    const sha = defaultSha(t, query.parse(req.query).sha);
    const tree = await treeOf(t, sha);
    return {
      sha,
      truncated: tree.truncated,
      entries: tree.entries
        .filter((e) => e.type === "blob" || e.type === "tree")
        .map((e) => ({ path: e.path, type: e.type, size: e.size })),
    };
  });

  /** One file's text (binary and very large files are described, not sent). */
  app.get<{ Params: { submissionId: string } }>("/v1/submissions/:submissionId/code/file", async (req) => {
    const actor = await authenticate(req, db, verifier);
    const t = await reviewTarget(db, actor, req.params.submissionId);
    const q = query.parse(req.query);
    if (!q.path) throw new HttpError(400, "path_required", "Which file?");
    const sha = defaultSha(t, q.sha);
    const entry = (await treeOf(t, sha)).entries.find((e) => e.path === q.path && e.type === "blob");
    if (!entry) throw notFound("No such file at this commit");
    if ((entry.size ?? 0) > MAX_FILE_BYTES) {
      return { path: entry.path, sha, size: entry.size, binary: false, tooLarge: true, content: null };
    }
    const bytes = await github.forInstallation(t.installationId).getBlob(t.owner, t.name, entry.sha);
    const binary = bytes.subarray(0, 8000).includes(0);
    return {
      path: entry.path,
      sha,
      size: bytes.length,
      binary,
      tooLarge: false,
      content: binary ? null : bytes.toString("utf8"),
    };
  });

  /** What changed between two commits; by default from where the student started to the graded commit. */
  app.get<{ Params: { submissionId: string } }>("/v1/submissions/:submissionId/code/compare", async (req) => {
    const actor = await authenticate(req, db, verifier);
    const t = await reviewTarget(db, actor, req.params.submissionId);
    const q = z
      .object({ base: z.string().regex(SHA).optional(), head: z.string().regex(SHA).optional() })
      .parse(req.query);
    const head = defaultSha(t, q.head);
    const gh = github.forInstallation(t.installationId);
    let base = q.base ?? t.start_sha;
    if (!base) {
      base = await gh.rootCommit(t.owner, t.name, head);
      await db.updateTable("repositories").set({ start_sha: base }).where("id", "=", t.repositoryId).execute();
    }
    const diff = await gh.compare(t.owner, t.name, base, head);
    return { base, head, ...diff };
  });
}
