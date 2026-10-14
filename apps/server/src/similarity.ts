import {
  fingerprint,
  isComparable,
  similarPairs,
  type Fingerprints,
  type SimilarPair,
  type SourceFile,
} from "@hbe/core";
import type { Db, Json } from "@hbe/db";
import type { GitHubClient } from "@hbe/github";
import type { FastifyBaseLogger } from "fastify";
import { ARCHIVE_BUCKET } from "./routes/runs.ts";
import type { ObjectStore } from "./storage.ts";
import { readTarGz } from "./tar.ts";

/** Files larger than this aren't compared (generated code, data). */
const MAX_FILE_BYTES = 256 * 1024;
const MAX_STARTER_FILES = 300;
/** Pairs kept per report, and passages kept per pair. */
const MAX_PAIRS = 200;
const MAX_MATCHES = 20;

export interface SimilarityDeps {
  db: Db;
  store: ObjectStore;
  github: GitHubClient;
  log: FastifyBaseLogger;
}

const textOf = (data: Buffer) => (data.includes(0) ? null : data.toString("utf8"));

/**
 * Runs one similarity check (similarity_reports.id): fingerprints each repository's graded
 * commit from its archived tarball (a team's repository counts once), leaves out the starter
 * code (the repository's first commit, from GitHub) and compares every pair.
 */
export async function checkSimilarity(deps: SimilarityDeps, reportId: string): Promise<void> {
  const { db, store, log } = deps;
  const report = await db
    .updateTable("similarity_reports")
    .set({ status: "running" })
    .where("id", "=", reportId)
    .where("status", "in", ["queued", "running"])
    .returning(["id", "assignment_id"])
    .executeTakeFirst();
  if (!report) return;

  try {
    const rows = await db
      .selectFrom("submissions as s")
      .leftJoin("submission_snapshots as snap", (j) =>
        j.onRef("snap.submission_id", "=", "s.id").onRef("snap.sha", "=", "s.final_sha"),
      )
      .leftJoin("repositories as r", "r.id", "s.repository_id")
      .leftJoin("github_installations as g", "g.id", "r.github_installation_id")
      .select([
        "s.id",
        "s.repository_id",
        "s.final_sha",
        "snap.tarball_path",
        "r.owner",
        "r.name",
        "r.start_sha",
        "g.installation_id",
      ])
      .where("s.assignment_id", "=", report.assignment_id)
      .where("s.final_sha", "is not", null)
      .orderBy("s.created_at")
      .execute();

    // One unit per repository (teammates share one) and commit.
    const units = new Map<string, (typeof rows)[number]>();
    const skipped: { submission_id: string; reason: string }[] = [];
    for (const row of rows) {
      if (!row.tarball_path) {
        skipped.push({ submission_id: row.id, reason: "The graded commit wasn't archived." });
        continue;
      }
      const key = `${row.repository_id ?? row.id}:${row.final_sha}`;
      if (!units.has(key)) units.set(key, row);
    }

    const compared: { id: string; fingerprints: Fingerprints }[] = [];
    for (const unit of units.values()) {
      const gz = await store.get(ARCHIVE_BUCKET, unit.tarball_path!);
      if (!gz) {
        skipped.push({ submission_id: unit.id, reason: "The archived commit couldn't be read." });
        continue;
      }
      const files: SourceFile[] = readTarGz(gz, (path, size) => isComparable(path) && size <= MAX_FILE_BYTES)
        .map((f) => ({ path: f.path, text: textOf(f.data) }))
        .filter((f): f is SourceFile => f.text !== null);
      compared.push({ id: unit.id, fingerprints: fingerprint(files) });
    }

    const starter = await starterFingerprints(deps, [...units.values()]);
    const pairs: SimilarPair<string>[] = compared.length >= 2 ? similarPairs(compared, starter ?? undefined) : [];

    await db.transaction().execute(async (tx) => {
      const { institution_id } = await tx
        .selectFrom("similarity_reports")
        .select("institution_id")
        .where("id", "=", reportId)
        .executeTakeFirstOrThrow();
      await tx.deleteFrom("similarity_pairs").where("report_id", "=", reportId).execute();
      if (pairs.length) {
        await tx
          .insertInto("similarity_pairs")
          .values(
            pairs.slice(0, MAX_PAIRS).map((p) => ({
              institution_id,
              report_id: reportId,
              submission_a: p.a,
              submission_b: p.b,
              score: p.score.toFixed(3),
              shared: p.shared,
              matches: JSON.stringify(p.matches.slice(0, MAX_MATCHES)) as Json,
            })),
          )
          .execute();
      }
      await tx
        .updateTable("similarity_reports")
        .set({
          status: "completed",
          compared: compared.length,
          skipped: JSON.stringify(skipped) as Json,
          starter_excluded: starter !== null,
          finished_at: new Date(),
          error: null,
        })
        .where("id", "=", reportId)
        .execute();
    });
    log.info({ reportId, compared: compared.length, pairs: pairs.length }, "similarity check done");
  } catch (err) {
    log.error({ err, reportId }, "similarity check failed");
    await db
      .updateTable("similarity_reports")
      .set({ status: "failed", error: String((err as Error).message ?? err).slice(0, 2000), finished_at: new Date() })
      .where("id", "=", reportId)
      .execute();
  }
}

/**
 * Fingerprints of the starter code: the first commit of a student repository (repositories
 * created from the template start with its files). Null when GitHub can't provide it.
 */
async function starterFingerprints(
  { github, log }: SimilarityDeps,
  units: {
    owner: string | null;
    name: string | null;
    start_sha: string | null;
    final_sha: string | null;
    installation_id: number | null;
  }[],
): Promise<Fingerprints | null> {
  const repo = units.find((u) => u.owner && u.name && u.installation_id && u.final_sha);
  if (!repo) return null;
  try {
    const gh = github.forInstallation(repo.installation_id!);
    const start = repo.start_sha ?? (await gh.rootCommit(repo.owner!, repo.name!, repo.final_sha!));
    const tree = await gh.getTree(repo.owner!, repo.name!, start);
    const entries = tree.entries
      .filter((e) => e.type === "blob" && isComparable(e.path) && (e.size ?? 0) <= MAX_FILE_BYTES)
      .slice(0, MAX_STARTER_FILES);
    const files: SourceFile[] = [];
    for (const e of entries) {
      const text = textOf(await gh.getBlob(repo.owner!, repo.name!, e.sha));
      if (text !== null) files.push({ path: e.path, text });
    }
    return fingerprint(files);
  } catch (err) {
    log.warn({ err, repo: `${repo.owner}/${repo.name}` }, "similarity: starter code not available");
    return null;
  }
}
