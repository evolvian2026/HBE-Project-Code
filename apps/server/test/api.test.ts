import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { FakeQueue, FakeVerifier, Fixtures, randomGithubId, testDb, testSettings, unique } from "./helpers.ts";

const db = testDb();
const fixtures = new Fixtures(db);
const verifier = new FakeVerifier();
let app: FastifyInstance;

let superAdmin: string;
let admin: string;
let adminWithGithub: string;
let teacher: string;
let institution: { id: string; slug: string };

beforeAll(async () => {
  app = await buildApp({ settings: testSettings(), db, queue: new FakeQueue(), verifier });
  superAdmin = await fixtures.user({ superAdmin: true });
  admin = await fixtures.user();
  adminWithGithub = await fixtures.user({ githubId: randomGithubId() });
  teacher = await fixtures.user();
  institution = await fixtures.institution([
    { userId: admin, role: "admin" },
    { userId: adminWithGithub, role: "admin" },
    { userId: teacher, role: "teacher" },
  ]);
});

afterAll(async () => {
  await app.close();
  await fixtures.cleanup();
  await db.destroy();
});

const as = (userId: string) => ({ authorization: `Bearer ${verifier.tokenFor(userId)}` });

describe("health", () => {
  it("reports liveness and readiness", async () => {
    expect((await app.inject("/healthz")).json()).toEqual({ status: "ok", roles: ["api", "worker"] });
    expect((await app.inject("/readyz")).statusCode).toBe(200);
  });
});

describe("GET /v1/me", () => {
  it("requires a valid token", async () => {
    expect((await app.inject("/v1/me")).statusCode).toBe(401);
    expect((await app.inject({ url: "/v1/me", headers: { authorization: "Bearer nope" } })).statusCode).toBe(401);
  });

  it("returns the profile and institutions from the database", async () => {
    const res = await app.inject({ url: "/v1/me", headers: as(teacher) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.isSuperAdmin).toBe(false);
    expect(body.institutions).toEqual([
      expect.objectContaining({ id: institution.id, slug: institution.slug, role: "teacher", status: "active" }),
    ]);
  });

  it("rejects deactivated accounts immediately", async () => {
    const user = await fixtures.user();
    await db.updateTable("profiles").set({ status: "deactivated" }).where("id", "=", user).execute();
    expect((await app.inject({ url: "/v1/me", headers: as(user) })).statusCode).toBe(401);
  });
});

describe("super admin: institutions", () => {
  it("forbids non-super-admins", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/platform/institutions",
      headers: as(admin),
      payload: { name: "Nope" },
    });
    expect(res.statusCode).toBe(403);
    expect((await app.inject({ url: "/v1/platform/institutions", headers: as(admin) })).statusCode).toBe(403);
  });

  it("creates an institution with an admin invitation, audited with the actor", async () => {
    const slug = `inst-${unique()}`;
    const res = await app.inject({
      method: "POST",
      url: "/v1/platform/institutions",
      headers: as(superAdmin),
      payload: { name: "Gamma Institute", slug, adminEmail: "Head@Gamma.Example" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    fixtures.institutionIds.push(body.institution.id);
    expect(body.institution).toMatchObject({ name: "Gamma Institute", slug, status: "active" });
    expect(body.invitation).toMatchObject({ email: "head@gamma.example", role: "admin" });

    const audit = await db
      .selectFrom("audit_logs")
      .select("actor_id")
      .where("entity", "=", "institutions")
      .where("entity_id", "=", body.institution.id)
      .executeTakeFirstOrThrow();
    expect(audit.actor_id).toBe(superAdmin);

    const dup = await app.inject({
      method: "POST",
      url: "/v1/platform/institutions",
      headers: as(superAdmin),
      payload: { name: "Again", slug },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe("slug_taken");
  });

  it("derives a slug from the name and validates input", async () => {
    const name = `Delta College ${unique()}`;
    const res = await app.inject({
      method: "POST",
      url: "/v1/platform/institutions",
      headers: as(superAdmin),
      payload: { name },
    });
    expect(res.statusCode).toBe(201);
    fixtures.institutionIds.push(res.json().institution.id);
    expect(res.json().institution.slug).toMatch(/^delta-college-[a-z0-9]+$/);

    const bad = await app.inject({
      method: "POST",
      url: "/v1/platform/institutions",
      headers: as(superAdmin),
      payload: { name: "X", slug: "Bad Slug" },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("lists institutions with member counts", async () => {
    const res = await app.inject({ url: "/v1/platform/institutions", headers: as(superAdmin) });
    const row = res.json().institutions.find((i: { id: string }) => i.id === institution.id);
    expect(row).toMatchObject({ member_count: 3, admin_count: 2 });
  });
});

describe("GitHub organisation linking", () => {
  const url = () => `/v1/institutions/${institution.id}/github/link-requests`;

  it("only lets institution admins start a link", async () => {
    expect((await app.inject({ method: "POST", url: url(), headers: as(teacher) })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: url(), headers: as(superAdmin) })).statusCode).toBe(403);
  });

  it("requires the admin to have linked their GitHub account", async () => {
    const res = await app.inject({ method: "POST", url: url(), headers: as(admin) });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("github_not_linked");
  });

  it("creates a link request and returns the install URL", async () => {
    const res = await app.inject({ method: "POST", url: url(), headers: as(adminWithGithub) });
    expect(res.statusCode).toBe(201);
    expect(res.json().installUrl).toBe("https://github.com/apps/hbe-test/installations/new");
  });

  it("lets a super admin map an installation manually", async () => {
    const installationId = randomGithubId();
    fixtures.installationIds.push(installationId);
    await db
      .insertInto("github_installations")
      .values({
        institution_id: null,
        installation_id: installationId,
        account_id: 1,
        account_login: "org",
        account_type: "Organization",
      })
      .execute();
    const res = await app.inject({
      method: "PUT",
      url: `/v1/platform/github-installations/${installationId}`,
      headers: as(superAdmin),
      payload: { institutionId: institution.id },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ installation_id: installationId, institution_id: institution.id });
  });

  it("sanitises the post-install redirect", async () => {
    const res = await app.inject("/v1/github/setup?installation_id=123&setup_action=install&next=https://evil.example");
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(
      "http://localhost:3000/github/installed?installation_id=123&setup_action=install",
    );
  });
});
