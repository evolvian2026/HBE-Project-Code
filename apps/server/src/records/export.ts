import { toCsv } from "@hbe/core";
import { sql } from "@hbe/db";
import { createHash } from "node:crypto";
import { createWriteStream, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import yazl from "yazl";
import { notify } from "../notifications.ts";
import { EXPORT_BUCKET, type RecordsDeps } from "./deps.ts";

/** A safe file or folder name inside the ZIP. */
const part = (s: string) => s.replace(/[^\w.@-]+/g, "_").slice(0, 80) || "_";

interface FileRow {
  course: string;
  assignment: string;
  student: string;
  user_id: string;
  bucket: string;
  path: string;
  name: string;
}

/**
 * Builds an institution's full export (§12.5): every grade report (PDF and JSON, every version),
 * every source snapshot (git bundle and tarball), and CSVs of grades and submissions, in one ZIP
 * with a manifest. The ZIP streams to the archive bucket (or, without one, to Storage).
 */
export async function buildExport(deps: RecordsDeps, exportId: string): Promise<"ready" | "failed" | "skipped"> {
  const { db, store, archive, log } = deps;
  const job = await db
    .updateTable("record_exports")
    .set({ status: "running" })
    .where("id", "=", exportId)
    .where("status", "=", "queued")
    .returning(["institution_id", "requested_by"])
    .executeTakeFirst();
  if (!job) return "skipped";
  const inst = await db
    .selectFrom("institutions")
    .select(["name", "slug"])
    .where("id", "=", job.institution_id)
    .executeTakeFirstOrThrow();

  const work = mkdtempSync(path.join(tmpdir(), "hbe-export-"));
  try {
    const where = (dir: string, r: { course: string; assignment: string; student: string; user_id: string }) =>
      `${dir}/${part(r.course)}/${part(r.assignment)}/${part(r.student)}-${r.user_id.slice(0, 8)}`;
    const { rows: files } = await sql<FileRow>`
      select c.code || '-' || c.term as course, a.slug as assignment, coalesce(p.email, p.full_name, 'student') as student,
             s.user_id, f.bucket, f.path, f.name
      from (
        select submission_id, 'grade-reports' as bucket, json_path as path, 'report-v' || version || '.json' as name
          from grade_reports where institution_id = ${job.institution_id}
        union all select submission_id, 'grade-reports', pdf_path, 'report-v' || version || '.pdf'
          from grade_reports where institution_id = ${job.institution_id}
        union all select submission_id, 'submission-archive', bundle_path, sha || '.bundle'
          from submission_snapshots where institution_id = ${job.institution_id}
        union all select submission_id, 'submission-archive', tarball_path, sha || '.tar.gz'
          from submission_snapshots where institution_id = ${job.institution_id}
      ) f
      join submissions s on s.id = f.submission_id
      join assignments a on a.id = s.assignment_id
      join courses c on c.id = a.course_id
      left join profiles p on p.id = s.user_id
      order by 1, 2, 3, f.bucket, f.name`.execute(db);

    const { rows: grades } = await sql<Record<string, string | number | boolean | null>>`
      select c.code as course, c.term, a.slug as assignment, a.title as assignment_title,
             p.full_name as student, p.email, p.github_login, s.status, s.final_sha, s.submitted_at::text,
             s.late_days, g.version as grade_version, g.final_score::float8 as final_score, g.complete,
             g.released_at::text, ps.score::float8 as process_score
      from submissions s
      join assignments a on a.id = s.assignment_id
      join courses c on c.id = a.course_id
      left join profiles p on p.id = s.user_id
      left join grades g on g.submission_id = s.id and g.is_current
      left join process_snapshots ps on ps.submission_id = s.id
      where s.institution_id = ${job.institution_id}
      order by c.code, c.term, a.slug, p.email`.execute(db);
    const columns = Object.keys(grades[0] ?? { course: null });
    const gradesCsv = toCsv([columns, ...grades.map((g) => columns.map((k) => g[k]))]);

    const zip = new yazl.ZipFile();
    const manifest: string[] = [];
    const missing: string[] = [];
    zip.addBuffer(Buffer.from(gradesCsv), "grades.csv");
    for (const f of files) {
      const name = `${where(f.bucket === "grade-reports" ? "reports" : "snapshots", f)}/${f.name}`;
      manifest.push(name);
      zip.addReadStreamLazy(name, (cb) => {
        store.stream(f.bucket, f.path).then(
          (stream) => {
            if (stream) return cb(null, stream);
            missing.push(name);
            cb(null, Readable.from([Buffer.from("This file was not in storage when the export was made.\n")]));
          },
          (err) => cb(err, undefined as unknown as NodeJS.ReadableStream),
        );
      });
    }
    // Written last, once every file has been read.
    zip.addReadStreamLazy("README.txt", (cb) =>
      cb(
        null,
        Readable.from([
          [
            `Records of ${inst.name}, exported ${new Date().toISOString()}.`,
            "",
            "grades.csv: every submission, with its current grade (if any) and process score.",
            "reports/<course>/<assignment>/<student>/report-vN.pdf|json: every released grade report version.",
            "  Each JSON report's SHA-256 is recorded in the platform (tamper evidence).",
            "snapshots/<course>/<assignment>/<student>/<sha>.bundle|.tar.gz: the source of each graded commit",
            "  (git bundle of the history, and a tarball of the tree).",
            "",
            `${manifest.length} files${missing.length ? `; not found in storage: ${missing.length}` : ""}:`,
            ...manifest.map((m) => `  ${m}${missing.includes(m) ? "  (missing)" : ""}`),
            "",
          ].join("\n"),
        ]),
      ),
    );
    zip.end();

    const hash = createHash("sha256");
    let size = 0;
    const counted = new PassThrough();
    counted.on("data", (chunk: Buffer) => {
      hash.update(chunk);
      size += chunk.length;
    });
    (zip.outputStream as Readable).pipe(counted);

    let location: "archive" | "storage";
    let key: string;
    if (archive) {
      location = "archive";
      key = `exports/${job.institution_id}/${exportId}.zip`;
      await archive.put(key, counted, { contentType: "application/zip", lockUntil: null });
    } else {
      location = "storage";
      key = `${job.institution_id}/${exportId}.zip`;
      const file = path.join(work, "export.zip");
      await pipeline(counted, createWriteStream(file));
      await store.put(EXPORT_BUCKET, key, readFileSync(file), "application/zip");
    }

    await db
      .updateTable("record_exports")
      .set({
        status: "ready",
        location,
        path: key,
        size,
        sha256: hash.digest("hex"),
        files: manifest.length + 2,
        finished_at: new Date(),
      })
      .where("id", "=", exportId)
      .execute();
    if (job.requested_by) {
      await notify(
        db,
        {
          institutionId: job.institution_id,
          userId: job.requested_by,
          type: "records_notice",
          title: `Your export of ${inst.name}'s records is ready`,
          body: `${manifest.length} report and snapshot files, plus grades.csv${missing.length ? ` (${missing.length} files were missing)` : ""}.`,
          link: `/i/${inst.slug}/records`,
          dedupeKey: `export:${exportId}`,
        },
        deps.queue,
      );
    }
    log.info({ exportId, files: manifest.length, size, location }, "records export ready");
    return "ready";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .updateTable("record_exports")
      .set({ status: "failed", error: message.slice(0, 1000), finished_at: new Date() })
      .where("id", "=", exportId)
      .execute();
    log.error({ exportId, err: message }, "records export failed");
    return "failed";
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
