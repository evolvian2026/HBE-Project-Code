import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import type { MfaAdmin } from "../src/mfa-admin.ts";
import { FakeQueue, FakeVerifier, Fixtures, testDb, testSettings } from "./helpers.ts";

const db = testDb();
const fixtures = new Fixtures(db);
const verifier = new FakeVerifier();
const removed: string[] = [];
const mfaAdmin: MfaAdmin = {
  async removeFactors(userId) {
    removed.push(userId);
    return 1;
  },
};
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ settings: testSettings(), db, queue: new FakeQueue(), verifier, mfaAdmin });
});
afterAll(async () => {
  await app.close();
  await fixtures.cleanup();
  await db.destroy();
});

const reset = (institutionId: string, userId: string, actor: string, aal: "aal1" | "aal2" = "aal2") =>
  app.inject({
    method: "POST",
    url: `/v1/institutions/${institutionId}/members/${userId}/reset-mfa`,
    headers: { authorization: `Bearer ${verifier.tokenFor(actor, aal)}` },
  });

describe("resetting a member's two-factor authentication", () => {
  it("is for the institution's admins, audited, and the person is told by email", async () => {
    const admin = await fixtures.user();
    const teacher = await fixtures.user();
    const student = await fixtures.user({ email: `lost-phone-${Date.now()}@test.local` });
    const inst = await fixtures.institution([
      { userId: admin, role: "admin" },
      { userId: teacher, role: "teacher" },
      { userId: student, role: "student" },
    ]);

    expect((await reset(inst.id, student, teacher)).statusCode).toBe(403);
    expect((await reset(inst.id, student, admin, "aal1")).statusCode).toBe(403);
    expect((await reset(inst.id, admin, admin)).statusCode).toBe(403); // not their own
    const outsider = await fixtures.user();
    expect((await reset(inst.id, outsider, admin)).statusCode).toBe(404);

    const res = await reset(inst.id, student, admin);
    expect(res.json()).toEqual({ removed: 1 });
    expect(removed).toContain(student);
    expect(
      await db
        .selectFrom("audit_logs")
        .select(["actor_id", "action", "entity", "entity_id"])
        .where("institution_id", "=", inst.id)
        .where("entity", "=", "mfa_factors")
        .executeTakeFirstOrThrow(),
    ).toEqual({ actor_id: admin, action: "delete", entity: "mfa_factors", entity_id: student });
    const notice = await db
      .selectFrom("notifications")
      .select(["id", "type"])
      .where("user_id", "=", student)
      .executeTakeFirstOrThrow();
    expect(notice.type).toBe("account_security");
    // Emailed even though the student never opted in to security emails.
    const email = await db
      .selectFrom("email_outbox")
      .select(["template", "payload"])
      .where("institution_id", "=", inst.id)
      .executeTakeFirstOrThrow();
    expect(email).toMatchObject({
      template: "notification",
      payload: expect.objectContaining({ type: "account_security" }),
    });
  });

  it("is the platform operator's for people who also belong elsewhere or have platform roles", async () => {
    const operator = await fixtures.user({ superAdmin: true });
    const admin = await fixtures.user();
    const shared = await fixtures.user();
    const inst = await fixtures.institution([
      { userId: admin, role: "admin" },
      { userId: shared, role: "teacher" },
    ]);
    await fixtures.institution([{ userId: shared, role: "admin" }]);

    const refused = await reset(inst.id, shared, admin);
    expect(refused.statusCode).toBe(403);
    expect(refused.body).toMatch(/platform operator/);
    expect((await reset(inst.id, operator, admin)).statusCode).toBe(404); // not a member here
    expect((await reset(inst.id, shared, operator)).json()).toEqual({ removed: 1 });
  });
});
