import { createHash } from "node:crypto";
import { sql, type Db } from "@hbe/db";
import type { FastifyBaseLogger } from "fastify";
import type { ObjectStore } from "../storage.ts";
import { buildGradeReport } from "./data.ts";
import { renderGradeReportPdf } from "./pdf.ts";

export const REPORTS_BUCKET = "grade-reports";

export interface ReportDeps {
  db: Db;
  store: ObjectStore;
  log: FastifyBaseLogger;
}

/**
 * Writes the grade report of one released grade version: canonical JSON (the record, with its
 * SHA-256) and a PDF rendering, both in Storage, plus an immutable grade_reports row. Reports
 * of a submission are numbered in order; generating twice for a version is a no-op.
 */
export async function generateGradeReport(
  deps: ReportDeps,
  gradeId: string,
): Promise<"created" | "exists" | "skipped"> {
  const { db, store, log } = deps;
  const grade = await db
    .selectFrom("grades")
    .select(["id", "institution_id", "submission_id", "user_id", "version", "released_at"])
    .where("id", "=", gradeId)
    .executeTakeFirst();
  if (!grade?.released_at) return "skipped";

  return db.transaction().execute(async (tx) => {
    // One report at a time per submission, so version numbers follow release order.
    await sql`select pg_advisory_xact_lock(hashtext(${`report:${grade.submission_id}`}))`.execute(tx);
    const existing = await tx
      .selectFrom("grade_reports")
      .select("id")
      .where("grade_id", "=", gradeId)
      .executeTakeFirst();
    if (existing) return "exists";
    const { n } = await tx
      .selectFrom("grade_reports")
      .select((eb) => eb.fn.coalesce(eb.fn.max("version"), eb.lit(0)).as("n"))
      .where("submission_id", "=", grade.submission_id)
      .executeTakeFirstOrThrow();
    const version = Number(n) + 1;

    const report = await buildGradeReport(tx, gradeId, version);
    if (!report) return "skipped";
    const json = JSON.stringify(report, null, 2);
    const sha256 = createHash("sha256").update(json).digest("hex");
    const pdf = await renderGradeReportPdf(report, sha256);
    const base = `${grade.institution_id}/${grade.submission_id}/${grade.id}`;
    await store.put(REPORTS_BUCKET, `${base}.json`, Buffer.from(json), "application/json");
    await store.put(REPORTS_BUCKET, `${base}.pdf`, pdf, "application/pdf");

    await tx
      .insertInto("grade_reports")
      .values({
        institution_id: grade.institution_id,
        submission_id: grade.submission_id,
        grade_id: grade.id,
        user_id: grade.user_id,
        version,
        grade_version: grade.version,
        json_path: `${base}.json`,
        pdf_path: `${base}.pdf`,
        sha256,
        pdf_sha256: createHash("sha256").update(pdf).digest("hex"),
      })
      .execute();
    log.info({ gradeId, version }, "grade report written");
    return "created";
  });
}
