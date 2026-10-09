import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "@hbe/db";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { MemoryArchiveStore, s3ArchiveStore } from "../src/archive.ts";
import { recomputeGrade } from "../src/grading.ts";
import { buildExport } from "../src/records/export.ts";
import { purgeDueInstitutions, sendPurgeNotices } from "../src/records/lifecycle.ts";
import { replicateRecords } from "../src/records/replication.ts";
import { MemoryObjectStore } from "../src/storage.ts";
import { FakeQueue, FakeVerifier, Fixtures, testDb, testSettings } from "./helpers.ts";
import { createGradedScenario, type GradedScenario } from "./scenario.ts";

const db = testDb();
const fixtures = new Fixtures(db);
const settings = testSettings();
const log = Fastify({ logger: false }).log;
const verifier = new FakeVerifier();
const DAY = 86_400_000;
let app: FastifyInstance;
let store: MemoryObjectStore;
let archive: MemoryArchiveStore;

beforeAll(async () => {
  store = new MemoryObjectStore();
  archive = new MemoryArchiveStore(true);
  app = await buildApp({ settings, db, queue: new FakeQueue(), verifier, store, archive });
});
afterAll(async () => {
  await app.close();
  await fixtures.cleanup();
  await db.destroy();
});

const as = (userId: string) => ({ authorization: `Bearer ${verifier.tokenFor(userId)}` });
const deps = () => ({ db, store, archive, settings, log });

/** A graded submission with a released grade report and a source snapshot, and their files. */
async function withRecords(): Promise<GradedScenario & { admin: string; files: string[] }> {
  const s = await createGradedScenario(db, fixtures, settings);
  const admin = await fixtures.user();
  await db
    .insertInto("institution_memberships")
    .values({ institution_id: s.institutionId, user_id: admin, role: "admin", external_id: null })
    .execute();
  await recomputeGrade(db, s.submissionId, { actorId: null });
  const grade = await db
    .selectFrom("grades")
    .select(["id", "user_id"])
    .where("submission_id", "=", s.submissionId)
    .where("is_current", "=", true)
    .executeTakeFirstOrThrow();
  const base = `${s.institutionId}/${s.submissionId}`;
  await db
    .insertInto("grade_reports")
    .values({
      institution_id: s.institutionId,
      submission_id: s.submissionId,
      grade_id: grade.id,
      user_id: grade.user_id,
      version: 1,
      grade_version: 1,
      json_path: `${base}/v1.json`,
      pdf_path: `${base}/v1.pdf`,
      sha256: "a".repeat(64),
      pdf_sha256: "b".repeat(64),
    })
    .execute();
  await db
    .insertInto("submission_snapshots")
    .values({
      institution_id: s.institutionId,
      submission_id: s.submissionId,
      sha: "c".repeat(40),
      run_id: s.runId,
      bundle_path: `${base}/${"c".repeat(40)}.bundle`,
      bundle_sha256: "d".repeat(64),
      bundle_size: 6,
      tarball_path: `${base}/${"c".repeat(40)}.tar.gz`,
      tarball_sha256: "e".repeat(64),
      tarball_size: 7,
    })
    .execute();
  await store.put("grade-reports", `${base}/v1.json`, Buffer.from('{"report":1}'), "application/json");
  await store.put("grade-reports", `${base}/v1.pdf`, Buffer.from("%PDF-1"), "application/pdf");
  await store.put("submission-archive", `${base}/${"c".repeat(40)}.bundle`, Buffer.from("bundle"), "x");
  // The tarball's upload never arrived: replication tries it again later.
  return { ...s, admin, files: [`${base}/v1.json`, `${base}/v1.pdf`] };
}

describe("contract end", () => {
  it("makes the institution read-only and sets the purge date; platform admins can reopen it", async () => {
    const s = await withRecords();
    const end = (userId: string, payload: object) =>
      app.inject({ method: "POST", url: `/v1/institutions/${s.institutionId}/contract`, headers: as(userId), payload });
    expect((await end(s.instructor, { action: "end" })).statusCode).toBe(403);
    const ended = await end(s.admin, { action: "end", endedAt: "2026-06-30T00:00:00Z" });
    expect(ended.statusCode).toBe(200);
    const inst = await db
      .selectFrom("institutions")
      .selectAll()
      .where("id", "=", s.institutionId)
      .executeTakeFirstOrThrow();
    expect(inst.status).toBe("read_only");
    expect(inst.purge_after!.toISOString().slice(0, 10)).toBe("2028-06-30");
    expect((await end(s.admin, { action: "end" })).statusCode).toBe(403); // no admin powers once read-only
    expect((await end(s.admin, { action: "reopen" })).statusCode).toBe(403);
    const root = await fixtures.user({ superAdmin: true });
    expect((await end(root, { action: "reopen" })).json().institution).toMatchObject({
      status: "active",
      purge_after: null,
    });
  });
});

describe("replication", () => {
  it("copies record files to the archive once, under Object Lock, and retries missing ones", async () => {
    const s = await withRecords();
    const first = await replicateRecords(deps());
    expect(first.copied).toBeGreaterThanOrEqual(3);
    const report = archive.objects.get(`grade-reports/${s.files[0]}`)!;
    expect(report.body.toString()).toBe('{"report":1}');
    expect(report.lockUntil!.getTime()).toBeGreaterThan(Date.now() + 700 * DAY); // contract + 2 years
    const rows = await db
      .selectFrom("replicated_objects")
      .selectAll()
      .where("institution_id", "=", s.institutionId)
      .execute();
    expect(rows.map((r) => r.bucket).sort()).toEqual(["grade-reports", "grade-reports", "submission-archive"]);

    expect((await replicateRecords(deps())).copied).toBe(0);
    // The missing tarball arrives: it's copied next time.
    const tarball = `${s.institutionId}/${s.submissionId}/${"c".repeat(40)}.tar.gz`;
    await store.put("submission-archive", tarball, Buffer.from("tarball"), "x");
    expect((await replicateRecords(deps())).copied).toBe(1);
    expect(archive.objects.get(`submission-archive/${tarball}`)?.body.toString()).toBe("tarball");
  });

  it("works against a real S3 API (local Supabase Storage)", async (ctx) => {
    const key = process.env.SUPABASE_S3_ACCESS_KEY_ID;
    if (!key) return ctx.skip();
    const s3 = s3ArchiveStore(
      testSettings({
        ARCHIVE_S3_ENDPOINT: "http://127.0.0.1:54321/storage/v1/s3",
        ARCHIVE_S3_REGION: "local",
        ARCHIVE_S3_BUCKET: "record-exports",
        ARCHIVE_S3_ACCESS_KEY_ID: key,
        ARCHIVE_S3_SECRET_ACCESS_KEY: process.env.SUPABASE_S3_SECRET_ACCESS_KEY ?? "",
      }),
    )!;
    await s3.probe(); // the preflight's check
    const objectKey = `s3-test/${Date.now()}.zip`;
    await s3.put(objectKey, Buffer.from("PK test"), { contentType: "application/zip" });
    expect((await s3.get(objectKey))?.toString()).toBe("PK test");
    const url = await s3.downloadUrl(objectKey, 60, "test.zip");
    expect(await (await fetch(url)).text()).toBe("PK test");
    await s3.remove([objectKey]);
    expect(await s3.get(objectKey)).toBeNull();
  });
});

describe("exports", () => {
  it("builds a ZIP of reports, snapshots and grades for institution admins", async () => {
    const s = await withRecords();
    const start = (userId: string) =>
      app.inject({ method: "POST", url: `/v1/institutions/${s.institutionId}/exports`, headers: as(userId) });
    expect((await start(s.instructor)).statusCode).toBe(403);
    const created = await start(s.admin);
    expect(created.statusCode).toBe(201);
    expect((await start(s.admin)).json()).toMatchObject({ error: "export_running" });
    const id = created.json().export.id as string;

    // Without an archive bucket the ZIP goes to Storage (local development).
    expect(await buildExport({ ...deps(), archive: null }, id)).toBe("ready");
    const exp = await db.selectFrom("record_exports").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
    expect(exp).toMatchObject({ status: "ready", location: "storage", files: 6 });
    const zip = (await store.get("record-exports", exp.path!))!;
    expect(exp.size).toBe(zip.length);
    const dir = mkdtempSync(path.join(tmpdir(), "hbe-export-test-"));
    try {
      writeFileSync(path.join(dir, "x.zip"), zip);
      const listing = execFileSync("unzip", ["-l", path.join(dir, "x.zip")], { encoding: "utf8" });
      expect(listing).toContain("grades.csv");
      expect(listing).toMatch(/reports\/.+\/report-v1\.pdf/);
      expect(listing).toMatch(/snapshots\/.+\/c{40}\.bundle/);
      expect(listing).toContain("README.txt");
      const readme = execFileSync("unzip", ["-p", path.join(dir, "x.zip"), "README.txt"], { encoding: "utf8" });
      expect(readme).toMatch(/not found in storage: 1/); // the tarball that never arrived
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const [n] = await db.selectFrom("notifications").selectAll().where("user_id", "=", s.admin).execute();
    expect(n).toMatchObject({ type: "records_notice", link: expect.stringMatching(/\/records$/) });

    const download = await app.inject({ url: `/v1/record-exports/${id}/download`, headers: as(s.admin) });
    expect(download.json().url).toMatch(/^memory:\/\/record-exports\//);
    expect((await app.inject({ url: `/v1/record-exports/${id}/download`, headers: as(s.instructor) })).statusCode).toBe(
      403,
    );
  });
});

describe("purge", () => {
  it("warns admins 90 and 30 days ahead, by email too, once each", async () => {
    const s = await withRecords();
    const now = new Date();
    await db
      .updateTable("institutions")
      .set({ status: "read_only", contract_ended_at: now, purge_after: new Date(now.getTime() + 80 * DAY) })
      .where("id", "=", s.institutionId)
      .execute();
    expect(await sendPurgeNotices(deps(), now)).toBeGreaterThanOrEqual(1);
    await sendPurgeNotices(deps(), now);
    const notices = await db.selectFrom("notifications").selectAll().where("user_id", "=", s.admin).execute();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.title).toMatch(/will be deleted in 80 days/);
    const emails = await db
      .selectFrom("email_outbox")
      .selectAll()
      .where("institution_id", "=", s.institutionId)
      .where("template", "=", "notification")
      .execute();
    expect(emails.some((e) => (e.payload as { type: string }).type === "records_notice")).toBe(true);
    await sendPurgeNotices(deps(), new Date(now.getTime() + 55 * DAY)); // 25 days left
    expect(await db.selectFrom("notifications").selectAll().where("user_id", "=", s.admin).execute()).toHaveLength(2);
  });

  it("deletes the institution's files, replicas, rows and lone accounts, and leaves a certificate", async () => {
    const s = await withRecords();
    const other = await withRecords();
    await replicateRecords(deps());
    // The student also belongs to another institution: their account stays.
    await db
      .insertInto("institution_memberships")
      .values({ institution_id: other.institutionId, user_id: s.student, role: "student", external_id: null })
      .execute();
    await db
      .updateTable("institutions")
      .set({ status: "read_only", contract_ended_at: new Date(), purge_after: new Date(Date.now() - 1000) })
      .where("id", "=", s.institutionId)
      .execute();

    expect(await purgeDueInstitutions(deps())).toEqual([s.institutionId]);

    expect(await store.get("grade-reports", s.files[0]!)).toBeNull();
    expect(archive.objects.has(`grade-reports/${s.files[0]}`)).toBe(false);
    expect(await store.get("grade-reports", other.files[0]!)).not.toBeNull();
    const inst = await db.selectFrom("institutions").selectAll().where("id", "=", s.institutionId).executeTakeFirst();
    expect(inst).toMatchObject({ status: "purged", slug: s.slug });
    const { rows: left } = await sql<{ n: number }>`
      select (select count(*) from submissions where institution_id = ${s.institutionId})
           + (select count(*) from grades where institution_id = ${s.institutionId})
           + (select count(*) from institution_memberships where institution_id = ${s.institutionId})
           + (select count(*) from replicated_objects where institution_id = ${s.institutionId}) as n`.execute(db);
    expect(Number(left[0]!.n)).toBe(0);
    // The instructor belonged only here; the student also elsewhere.
    expect(
      await db.selectFrom("profiles").select("id").where("id", "=", s.instructor).executeTakeFirst(),
    ).toBeUndefined();
    expect(await db.selectFrom("profiles").select("id").where("id", "=", s.student).executeTakeFirst()).toBeDefined();
    const audit = await db.selectFrom("audit_logs").selectAll().where("institution_id", "=", s.institutionId).execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "purge", entity: "institution" });
    const certificate = audit[0]!.after as { rows: Record<string, number>; users_deleted: number; replicas: number };
    expect(certificate.rows.submissions).toBe(1);
    expect(certificate.replicas).toBeGreaterThanOrEqual(3);
    expect(certificate.users_deleted).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(certificate)).not.toMatch(/@/); // no email addresses
    // The other institution is untouched.
    expect(
      await db.selectFrom("submissions").select("id").where("institution_id", "=", other.institutionId).execute(),
    ).toHaveLength(1);
  });
});
