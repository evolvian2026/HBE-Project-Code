import { createHash } from "node:crypto";
import { sql } from "@hbe/db";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { MemoryArchiveStore } from "../src/archive.ts";
import { erasePerson } from "../src/erasure.ts";
import { recomputeGrade } from "../src/grading.ts";
import { replicateRecords } from "../src/records/replication.ts";
import { generateGradeReport } from "../src/reports/index.ts";
import { MemoryObjectStore } from "../src/storage.ts";
import { FakeQueue, FakeVerifier, Fixtures, testDb, testSettings } from "./helpers.ts";
import { createGradedScenario } from "./scenario.ts";

const db = testDb();
const fixtures = new Fixtures(db);
const settings = testSettings();
const log = Fastify({ logger: false }).log;
const verifier = new FakeVerifier();
const queue = new FakeQueue();
const store = new MemoryObjectStore();
const archive = new MemoryArchiveStore(true);
const pseudonyms: string[] = [];
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ settings, db, queue, verifier, store, archive });
});
afterAll(async () => {
  await app.close();
  await fixtures.cleanup();
  if (pseudonyms.length) await sql`delete from auth.users where id = any (${pseudonyms}::uuid[])`.execute(db);
  await db.destroy();
});

const as = (userId: string, aal: "aal1" | "aal2" = "aal2") => ({
  authorization: `Bearer ${verifier.tokenFor(userId, aal)}`,
});
const deps = () => ({ db, store, archive, settings, log, queue });

/** A student with a released grade (and its real report), a snapshot, commits, an invitation, a notification. */
async function studentWithRecords() {
  const s = await createGradedScenario(db, fixtures, settings);
  const admin = await fixtures.user();
  await db
    .insertInto("institution_memberships")
    .values({ institution_id: s.institutionId, user_id: admin, role: "admin" })
    .execute();
  const profile = await db
    .selectFrom("profiles")
    .select(["email", "github_login", "github_user_id"])
    .where("id", "=", s.student)
    .executeTakeFirstOrThrow();
  await db
    .updateTable("institution_memberships")
    .set({ external_id: "S-77123" })
    .where("institution_id", "=", s.institutionId)
    .where("user_id", "=", s.student)
    .execute();
  await db.updateTable("submissions").set({ grade_released_at: new Date() }).where("id", "=", s.submissionId).execute();
  await recomputeGrade(db, s.submissionId, { actorId: null });
  const grade = await db
    .selectFrom("grades")
    .select("id")
    .where("submission_id", "=", s.submissionId)
    .where("is_current", "=", true)
    .executeTakeFirstOrThrow();
  expect(await generateGradeReport({ db, store, log }, grade.id)).toBe("created");
  const base = `${s.institutionId}/${s.submissionId}`;
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
  await store.put("submission-archive", `${base}/${"c".repeat(40)}.bundle`, Buffer.from("bundle"), "x");
  await store.put("submission-archive", `${base}/${"c".repeat(40)}.tar.gz`, Buffer.from("tarball"), "x");
  await sql`insert into commits (institution_id, repository_id, sha, message, authored_at, author_login, author_github_id,
                                 author_email, author_name, author_profile_id, details_status)
            values (${s.institutionId}, ${s.repositoryId}, ${"f".repeat(40)}, 'Add the API', now(), ${profile.github_login},
                    ${profile.github_user_id}, ${profile.email}, 'Ada Lovelace', ${s.student}, 'done')`.execute(db);
  await db
    .insertInto("invitations")
    .values({ institution_id: s.institutionId, email: profile.email!, role: "student", accepted_by: s.student })
    .execute();
  return { ...s, admin, profile, gradeId: grade.id, base };
}

const textOf = async (q: ReturnType<typeof sql<{ t: string | null }>>) =>
  (await q.execute(db)).rows.map((r) => r.t ?? "").join("\n");

describe("erasing a person's data", () => {
  it("anonymises a student who asked: records stay under a pseudonym, nothing identifies them", async () => {
    const s = await studentWithRecords();

    // The student asks; the admins are told.
    const asked = await app.inject({
      method: "POST",
      url: "/v1/me/erasure-requests",
      headers: as(s.student),
      payload: { institutionId: s.institutionId, note: "I'm leaving the programme." },
    });
    expect(asked.statusCode).toBe(201);
    const requestId = asked.json().id as string;
    const again = await app.inject({
      method: "POST",
      url: "/v1/me/erasure-requests",
      headers: as(s.student),
      payload: { institutionId: s.institutionId },
    });
    expect(again.statusCode).toBe(409);
    const told = await db
      .selectFrom("notifications")
      .select("type")
      .where("user_id", "=", s.admin)
      .where("type", "=", "erasure_request")
      .execute();
    expect(told).toHaveLength(1);

    // Only another admin decides, with two-factor authentication.
    const decide = (userId: string, payload: object, aal: "aal1" | "aal2" = "aal2") =>
      app.inject({
        method: "POST",
        url: `/v1/erasure-requests/${requestId}/decision`,
        headers: as(userId, aal),
        payload,
      });
    expect((await decide(s.student, { decision: "anonymise" })).statusCode).toBe(403);
    expect((await decide(s.instructor, { decision: "anonymise" })).statusCode).toBe(403);
    expect((await decide(s.admin, { decision: "anonymise" }, "aal1")).statusCode).toBe(403);
    expect((await decide(s.admin, { decision: "anonymise" })).json()).toEqual({ status: "approved" });
    expect(queue.sent.at(-1)).toMatchObject({ name: "erase-person", data: { requestId } });

    expect(await erasePerson(deps(), requestId)).toBe("completed");
    const done = await db
      .selectFrom("erasure_requests")
      .selectAll()
      .where("id", "=", requestId)
      .executeTakeFirstOrThrow();
    pseudonyms.push(done.pseudonym_id!);
    expect(done).toMatchObject({
      status: "completed",
      subject_id: null,
      requested_by: null,
      note: null,
      mode: "anonymise",
    });
    expect(done.pseudonym).toMatch(/^Erased student [0-9A-F]{6}$/);
    expect(done.certificate).toMatchObject({
      mode: "anonymise",
      account_deleted: true,
      files: { reports_rewritten: 1 },
    });

    // Their account is gone; the records are the pseudonym's.
    expect(await db.selectFrom("profiles").select("id").where("id", "=", s.student).executeTakeFirst()).toBeUndefined();
    const ghost = await db
      .selectFrom("profiles")
      .select(["full_name", "email", "github_login", "status"])
      .where("id", "=", done.pseudonym_id!)
      .executeTakeFirstOrThrow();
    expect(ghost).toEqual({ full_name: done.pseudonym, email: null, github_login: null, status: "deactivated" });
    const sub = await db
      .selectFrom("submissions")
      .select("user_id")
      .where("id", "=", s.submissionId)
      .executeTakeFirstOrThrow();
    expect(sub.user_id).toBe(done.pseudonym_id);
    const member = await db
      .selectFrom("institution_memberships")
      .select(["external_id", "status"])
      .where("institution_id", "=", s.institutionId)
      .where("user_id", "=", done.pseudonym_id!)
      .executeTakeFirstOrThrow();
    expect(member).toEqual({ external_id: null, status: "deactivated" });

    // The grade report keeps its content, with the pseudonym as the student, and a new hash.
    const report = await db
      .selectFrom("grade_reports")
      .select(["json_path", "sha256"])
      .where("grade_id", "=", s.gradeId)
      .executeTakeFirstOrThrow();
    const json = (await store.get("grade-reports", report.json_path))!.toString("utf8");
    expect(JSON.parse(json).student).toEqual({
      name: done.pseudonym,
      email: null,
      github_login: null,
      student_id: null,
    });
    expect(createHash("sha256").update(json).digest("hex")).toBe(report.sha256);

    // Nothing that identifies them is left in the institution: not in commits, invitations,
    // notifications, nor the audit log's copies of rows.
    const identifiers = [s.profile.email!, s.profile.github_login!, s.student, "S-77123"];
    const leftovers = await textOf(sql`
      select concat_ws(' ', author_login, author_email, author_name, author_github_id::text) as t from commits where institution_id = ${s.institutionId}
      union all select email from invitations where institution_id = ${s.institutionId}
      union all select user_id::text from notifications where institution_id = ${s.institutionId}
      union all select concat_ws(' ', actor_id::text, entity_id::text, before::text, after::text) from audit_logs where institution_id = ${s.institutionId}
      union all select concat_ws(' ', owner, name) from repositories where institution_id = ${s.institutionId}`);
    for (const id of identifiers) expect(leftovers.toLowerCase()).not.toContain(id.toLowerCase());
    expect(json.toLowerCase()).not.toContain(s.profile.email!.toLowerCase());

    // The erasure itself is in the audit log, without personal data.
    const audit = await db
      .selectFrom("audit_logs")
      .select(["actor_id", "entity", "entity_id"])
      .where("institution_id", "=", s.institutionId)
      .where("entity", "=", "personal_data")
      .executeTakeFirstOrThrow();
    expect(audit).toEqual({ actor_id: s.admin, entity: "personal_data", entity_id: done.pseudonym_id });
  });

  it("deletes the records of someone who also belongs elsewhere, files and archive copies included, and keeps their account", async () => {
    const s = await studentWithRecords();
    await replicateRecords({ db, store, archive, settings, log }, { budgetMs: 60_000 });
    const replicas = [...archive.objects.keys()].filter((k) => k.includes(s.submissionId));
    expect(replicas.length).toBeGreaterThanOrEqual(3);
    const elsewhere = await fixtures.institution([{ userId: s.student, role: "student" }]);

    const res = await app.inject({
      method: "POST",
      url: `/v1/institutions/${s.institutionId}/erasure-requests`,
      headers: as(s.admin),
      payload: { userId: s.student, mode: "delete" },
    });
    expect(res.statusCode).toBe(201);
    const requestId = res.json().id as string;
    expect(await erasePerson(deps(), requestId)).toBe("completed");
    const done = await db
      .selectFrom("erasure_requests")
      .selectAll()
      .where("id", "=", requestId)
      .executeTakeFirstOrThrow();
    pseudonyms.push(done.pseudonym_id!);
    expect(done.certificate).toMatchObject({
      mode: "delete",
      account_deleted: false,
      records_deleted: { submissions: 1, repositories: 1 },
    });

    expect(
      await db.selectFrom("submissions").select("id").where("id", "=", s.submissionId).executeTakeFirst(),
    ).toBeUndefined();
    expect([...store.objects.keys()].filter((k) => k.includes(s.submissionId))).toEqual([]);
    expect([...archive.objects.keys()].filter((k) => k.includes(s.submissionId))).toEqual([]);
    // Still a member elsewhere, untouched.
    expect(await db.selectFrom("profiles").select("email").where("id", "=", s.student).executeTakeFirst()).toEqual({
      email: s.profile.email,
    });
    expect(
      await db
        .selectFrom("institution_memberships")
        .select("institution_id")
        .where("user_id", "=", s.student)
        .execute(),
    ).toEqual([{ institution_id: elsewhere.id }]);
  });

  it("refuses what it shouldn't do, and a declined request is explained to the person", async () => {
    const s = await studentWithRecords();
    const erase = (actor: string, userId: string) =>
      app.inject({
        method: "POST",
        url: `/v1/institutions/${s.institutionId}/erasure-requests`,
        headers: as(actor),
        payload: { userId, mode: "anonymise" },
      });
    expect((await erase(s.admin, s.admin)).statusCode).toBe(403); // not their own
    expect((await erase(s.instructor, s.student)).statusCode).toBe(403); // admins only
    // The institution's only admin can't be erased.
    const second = await fixtures.user();
    await db
      .insertInto("institution_memberships")
      .values({ institution_id: s.institutionId, user_id: second, role: "admin" })
      .execute();
    await db
      .updateTable("institution_memberships")
      .set({ status: "deactivated" })
      .where("institution_id", "=", s.institutionId)
      .where("user_id", "=", second)
      .execute();
    const lastAdmin = await app.inject({
      method: "POST",
      url: `/v1/institutions/${s.institutionId}/erasure-requests`,
      headers: as(s.admin),
      payload: { userId: second, mode: "anonymise" },
    });
    expect(lastAdmin.statusCode).toBe(201); // deactivated: not counted as an admin
    const operator = await fixtures.user({ superAdmin: true });
    await db
      .insertInto("institution_memberships")
      .values({ institution_id: s.institutionId, user_id: operator, role: "teacher" })
      .execute();
    const platform = await erase(s.admin, operator);
    expect(platform.statusCode).toBe(409);
    expect(platform.json().message).toMatch(/platform role/);

    // The student asks, an admin declines with a reason.
    const asked = await app.inject({
      method: "POST",
      url: "/v1/me/erasure-requests",
      headers: as(s.student),
      payload: { institutionId: s.institutionId },
    });
    const declined = await app.inject({
      method: "POST",
      url: `/v1/erasure-requests/${asked.json().id}/decision`,
      headers: as(s.admin),
      payload: { decision: "reject", note: "Your grades are still under appeal." },
    });
    expect(declined.json()).toEqual({ status: "rejected" });
    const notice = await db
      .selectFrom("notifications")
      .select(["title", "body"])
      .where("user_id", "=", s.student)
      .where("type", "=", "erasure_request")
      .executeTakeFirstOrThrow();
    expect(notice.body).toBe("Your grades are still under appeal.");
  });
});
