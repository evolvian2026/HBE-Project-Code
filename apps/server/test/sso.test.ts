import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { SsoAdminError, type SsoAdmin } from "../src/sso-admin.ts";
import { FakeQueue, FakeVerifier, Fixtures, testDb, testSettings, unique } from "./helpers.ts";

const db = testDb();
const fixtures = new Fixtures(db);
const verifier = new FakeVerifier();

/** Supabase Auth's admin API, in memory. */
class FakeSsoAdmin implements SsoAdmin {
  readonly providers = new Map<
    string,
    { domains: string[]; metadataUrl?: string; metadataXml?: string; disabled: boolean }
  >();
  refuse: string | null = null;
  async createProvider(input: { metadataUrl?: string; metadataXml?: string; domains: string[] }) {
    if (this.refuse) throw new SsoAdminError(this.refuse, 400);
    const id = crypto.randomUUID();
    this.providers.set(id, { ...input, disabled: false });
    return id;
  }
  async setDisabled(id: string, disabled: boolean) {
    this.providers.get(id)!.disabled = disabled;
  }
}

const ssoAdmin = new FakeSsoAdmin();
let app: FastifyInstance;
let off: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({
    settings: testSettings({ HBE__FEATURES__SAML_SSO: "true" }),
    db,
    queue: new FakeQueue(),
    verifier,
    ssoAdmin,
  });
  off = await buildApp({ settings: testSettings(), db, queue: new FakeQueue(), verifier, ssoAdmin });
});
afterAll(async () => {
  await app.close();
  await off.close();
  await fixtures.cleanup();
  await db.destroy();
});

const call = (
  server: FastifyInstance,
  method: "PUT" | "POST" | "PATCH",
  url: string,
  userId: string,
  payload: object = {},
) => server.inject({ method, url, headers: { authorization: `Bearer ${verifier.tokenFor(userId)}` }, payload });
const connectionOf = (institutionId: string) =>
  db.selectFrom("sso_connections").selectAll().where("institution_id", "=", institutionId).executeTakeFirstOrThrow();

describe("single sign-on", () => {
  it("is asked for by the institution's admins and turned on by the platform operator", async () => {
    const operator = await fixtures.user({ superAdmin: true });
    const admin = await fixtures.user();
    const teacher = await fixtures.user();
    const inst = await fixtures.institution([
      { userId: admin, role: "admin" },
      { userId: teacher, role: "teacher" },
    ]);
    const domain = `uni-${unique()}.edu`;
    const ask = (userId: string, payload: object, server = app) =>
      call(server, "PUT", `/v1/institutions/${inst.id}/sso`, userId, payload);
    const request = {
      domains: [domain, `students.${domain}`],
      metadataUrl: "https://login.example.edu/saml/metadata",
      joinAsStudent: true,
    };

    expect((await ask(admin, request, off)).json()).toMatchObject({ error: "sso_unavailable" }); // free plan
    expect((await ask(teacher, request)).statusCode).toBe(403);
    expect((await ask(admin, { ...request, domains: ["gmail.com"] })).json()).toMatchObject({ error: "public_domain" });
    expect((await ask(admin, { ...request, metadataUrl: "http://insecure.example.edu/m" })).statusCode).toBe(400);
    expect((await ask(admin, { ...request, metadataXml: `<md:EntityDescriptor>${"x".repeat(100)}` })).statusCode).toBe(
      400,
    ); // both
    const res = await ask(admin, request);
    expect(res.json()).toMatchObject({ status: "pending" });
    expect(await connectionOf(inst.id)).toMatchObject({
      domains: [domain, `students.${domain}`],
      requested_by: admin,
      join_as_student: true,
    });

    // Another institution can't claim the same domain.
    const otherAdmin = await fixtures.user();
    const other = await fixtures.institution([{ userId: otherAdmin, role: "admin" }]);
    const clash = await call(app, "PUT", `/v1/institutions/${other.id}/sso`, otherAdmin, {
      ...request,
      domains: [domain],
    });
    expect(clash.json()).toMatchObject({ error: "domain_taken" });

    // Only the operator turns it on, registering the IdP with Supabase Auth.
    const conn = await connectionOf(inst.id);
    const review = (userId: string, payload: object) =>
      call(app, "POST", `/v1/platform/sso/${conn.id}/review`, userId, payload);
    expect((await review(admin, { decision: "approve" })).statusCode).toBe(403);
    ssoAdmin.refuse = "metadata could not be fetched";
    expect((await review(operator, { decision: "approve" })).json()).toMatchObject({ error: "idp_refused" });
    ssoAdmin.refuse = null;
    expect((await review(operator, { decision: "approve" })).json()).toEqual({ status: "active" });
    const live = await connectionOf(inst.id);
    expect(live).toMatchObject({ status: "active", reviewed_by: operator });
    expect(ssoAdmin.providers.get(live.supabase_provider_id!)).toEqual({
      domains: [domain, `students.${domain}`],
      metadataUrl: "https://login.example.edu/saml/metadata",
      metadataXml: undefined,
      disabled: false,
    });
    expect((await review(operator, { decision: "approve" })).json()).toMatchObject({ error: "not_pending" });

    // While on, the IdP and domains are fixed; whether people join as students isn't.
    expect((await ask(admin, request)).json()).toMatchObject({ error: "sso_active" });
    expect(
      (await call(app, "PATCH", `/v1/institutions/${inst.id}/sso`, admin, { joinAsStudent: false })).json(),
    ).toEqual({
      joinAsStudent: false,
    });

    // Turned off: Supabase Auth refuses sign-ins through it. Asked again and turned on, the same
    // provider comes back (so people keep their accounts).
    expect((await call(app, "POST", `/v1/institutions/${inst.id}/sso/disable`, admin)).json()).toEqual({
      status: "disabled",
    });
    expect(ssoAdmin.providers.get(live.supabase_provider_id!)!.disabled).toBe(true);
    await ask(admin, request);
    expect((await review(operator, { decision: "approve" })).json()).toEqual({ status: "active" });
    expect((await connectionOf(inst.id)).supabase_provider_id).toBe(live.supabase_provider_id);
    expect(ssoAdmin.providers.get(live.supabase_provider_id!)!.disabled).toBe(false);
    expect(ssoAdmin.providers.size).toBe(1);

    const audit = await db
      .selectFrom("audit_logs")
      .select("actor_id")
      .where("institution_id", "=", inst.id)
      .where("entity", "=", "sso_connections")
      .execute();
    expect(audit.map((a) => a.actor_id)).toEqual(expect.arrayContaining([admin, operator]));
  });

  it("can be declined, with a note for the admins", async () => {
    const operator = await fixtures.user({ superAdmin: true });
    const admin = await fixtures.user();
    const inst = await fixtures.institution([{ userId: admin, role: "admin" }]);
    await call(app, "PUT", `/v1/institutions/${inst.id}/sso`, admin, {
      domains: [`college-${unique()}.edu`],
      metadataUrl: "https://idp.example.edu/metadata",
    });
    const conn = await connectionOf(inst.id);
    const res = await call(app, "POST", `/v1/platform/sso/${conn.id}/review`, operator, {
      decision: "reject",
      note: "Couldn't confirm you own college.edu: write to support.",
    });
    expect(res.json()).toEqual({ status: "rejected" });
    expect(await connectionOf(inst.id)).toMatchObject({
      status: "rejected",
      review_note: "Couldn't confirm you own college.edu: write to support.",
      supabase_provider_id: null,
    });
  });
});
