import { createServer, type Server } from "node:http";
import { ROLES, TestPlatform, type ServedPlatform, type TestUser } from "@hbe/lms/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import type { SignInService } from "../src/lti/sign-in.ts";
import { FakeQueue, FakeVerifier, Fixtures, testDb, testSettings, unique } from "./helpers.ts";
import { createScenario, type Scenario } from "./scenario.ts";

const db = testDb();
const fixtures = new Fixtures(db);
const settings = testSettings();
const verifier = new FakeVerifier();
let app: FastifyInstance;
let platform: ServedPlatform;
let s: Scenario;
let admin: string;
let connectionId: string;
const signIns: string[] = [];
const created: string[] = [];

/** Signs in by recording the email; accounts it creates are test fixtures. */
const signIn: SignInService = {
  async createUser(email) {
    const id = await fixtures.user({ email });
    created.push(email);
    return id;
  },
  async signInToken(email) {
    signIns.push(email);
    return `hash-${email}`;
  },
};

const as = (userId: string) => ({ authorization: `Bearer ${verifier.tokenFor(userId)}` });
const CLIENT_ID = `client-${unique()}`;
const DEPLOYMENT = "dep-1";

beforeAll(async () => {
  platform = await TestPlatform.serve();
  app = await buildApp({ settings, db, queue: new FakeQueue(), verifier, signIn });
  s = await createScenario(db, fixtures);
  admin = await fixtures.user();
  await db
    .insertInto("institution_memberships")
    .values({ institution_id: s.institutionId, user_id: admin, role: "admin", external_id: null })
    .execute();
});
afterAll(async () => {
  await app.close();
  await platform.close();
  await fixtures.cleanup();
  await db.destroy();
});

const emailOf = async (userId: string) =>
  (await db.selectFrom("profiles").select("email").where("id", "=", userId).executeTakeFirstOrThrow()).email!;

/** Login initiation, then a launch with an id_token for `user` (as the platform would post it). */
async function launch(
  user: TestUser,
  opts: {
    context?: { id: string; title?: string };
    custom?: Record<string, string>;
    headers?: Record<string, string>;
  } = {},
  overrides: { nonce?: string; messageType?: "LtiDeepLinkingRequest" } = {},
) {
  const login = await app.inject({
    method: "POST",
    url: "/lti/login",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({
      iss: platform.issuer,
      login_hint: user.sub,
      target_link_uri: `${settings.env.API_URL}/lti/launch`,
      client_id: CLIENT_ID,
    }).toString(),
  });
  expect(login.statusCode).toBe(302);
  const auth = new URL(login.headers.location as string);
  expect(auth.origin + auth.pathname).toBe(platform.authUrl);
  const state = auth.searchParams.get("state")!;
  const idToken = await platform.idToken({
    user,
    nonce: overrides.nonce ?? auth.searchParams.get("nonce")!,
    clientId: auth.searchParams.get("client_id")!,
    deploymentId: DEPLOYMENT,
    messageType: overrides.messageType,
    context: opts.context,
    custom: opts.custom,
  });
  const res = await app.inject({
    method: "POST",
    url: "/lti/launch",
    headers: { "content-type": "application/x-www-form-urlencoded", ...opts.headers },
    payload: new URLSearchParams({ id_token: idToken, state }).toString(),
  });
  return { res, state, idToken, auth };
}

const nextOf = (location: string) => {
  const url = new URL(location);
  expect(url.origin + url.pathname).toBe(`${settings.env.APP_URL}/auth/lti`);
  return { tokenHash: url.searchParams.get("token_hash"), next: url.searchParams.get("next") };
};

describe("LTI 1.3 tool", () => {
  it("publishes its signing keys", async () => {
    const res = await app.inject({ method: "GET", url: "/.well-known/jwks.json" });
    expect(res.statusCode).toBe(200);
    const [key] = res.json().keys;
    expect(key).toMatchObject({ kid: "local-dev", kty: "RSA", use: "sig" });
    expect(key).not.toHaveProperty("d");
  });

  it("lets institution admins (only) connect an LMS by hand", async () => {
    const body = {
      type: "canvas",
      name: "Canvas",
      issuer: platform.issuer,
      clientId: CLIENT_ID,
      deploymentIds: [DEPLOYMENT],
      authLoginUrl: platform.authUrl,
      authTokenUrl: `${platform.issuer}/token`,
      jwksUrl: platform.jwksUrl,
    };
    const url = `/v1/institutions/${s.institutionId}/lms-connections`;
    expect((await app.inject({ method: "POST", url, headers: as(s.instructor), payload: body })).statusCode).toBe(403);
    const res = await app.inject({ method: "POST", url, headers: as(admin), payload: body });
    expect(res.statusCode).toBe(201);
    connectionId = res.json().id;
    const again = await app.inject({ method: "POST", url, headers: as(admin), payload: body });
    expect(again.statusCode).toBe(409);
  });

  it("refuses logins from unknown platforms", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/lti/login?${new URLSearchParams({ iss: "https://unknown.test", login_hint: "x", target_link_uri: "https://x.test" })}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("isn&#39;t connected");
  });

  it("sends an instructor of an unlinked LMS course to link it, and signs them in", async () => {
    const context = { id: `ctx-${unique()}`, title: "Web Development (Canvas)" };
    const instructor = { sub: `lms-${unique()}`, email: await emailOf(s.instructor), roles: [ROLES.instructor] };
    const { res, state, idToken } = await launch(instructor, { context });
    expect(res.statusCode).toBe(302);
    const { tokenHash, next } = nextOf(res.headers.location as string);
    expect(tokenHash).toBe(`hash-${instructor.email}`);
    const link = await db
      .selectFrom("lms_course_links")
      .select(["id", "course_id", "context_title"])
      .where("lms_connection_id", "=", connectionId)
      .where("context_id", "=", context.id)
      .executeTakeFirstOrThrow();
    expect(link).toMatchObject({ course_id: null, context_title: context.title });
    expect(next).toBe(`/i/${s.slug}/lti/link-course/${link.id}`);
    const userLink = await db
      .selectFrom("lms_user_links")
      .select(["profile_id", "status", "matched_by"])
      .where("lms_user_id", "=", instructor.sub)
      .executeTakeFirstOrThrow();
    expect(userLink).toEqual({ profile_id: s.instructor, status: "linked", matched_by: "email" });

    // The login state is single use.
    const replay = await app.inject({
      method: "POST",
      url: "/lti/launch",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ id_token: idToken, state }).toString(),
    });
    expect(replay.statusCode).toBe(400);
    expect(replay.body).toContain("expired");

    // A student launching before the course is linked lands on the institution.
    const student = { sub: `lms-${unique()}`, email: await emailOf(s.otherStudent), roles: [ROLES.learner] };
    const early = await launch(student, { context });
    expect(nextOf(early.res.headers.location as string).next).toBe(`/i/${s.slug}?lti=course-not-linked`);

    // Students and admins of other institutions can't link it; the instructor can.
    const linkUrl = `/v1/lms-course-links/${link.id}/link`;
    const payload = { courseId: s.courseId };
    expect((await app.inject({ method: "POST", url: linkUrl, headers: as(s.student), payload })).statusCode).toBe(403);
    const linked = await app.inject({ method: "POST", url: linkUrl, headers: as(s.instructor), payload });
    expect(linked.statusCode).toBe(200);

    // Learners now land in the course (or the assignment named by the link) and join it.
    const newcomer = await fixtures.user();
    await db
      .insertInto("institution_memberships")
      .values({ institution_id: s.institutionId, user_id: newcomer, role: "student", external_id: null })
      .execute();
    const learner = { sub: `lms-${unique()}`, email: await emailOf(newcomer), roles: [ROLES.learner] };
    const inCourse = await launch(learner, { context, custom: { assignment_id: s.assignmentId } });
    expect(nextOf(inCourse.res.headers.location as string).next).toBe(
      `/i/${s.slug}/courses/${s.courseId}/assignments/${s.assignmentId}`,
    );
    const membership = await db
      .selectFrom("course_memberships")
      .select(["role", "source"])
      .where("course_id", "=", s.courseId)
      .where("user_id", "=", newcomer)
      .executeTakeFirstOrThrow();
    expect(membership).toEqual({ role: "student", source: "lms" });
  });

  it("creates the account of someone invited who hasn't signed in yet", async () => {
    const email = `invited-${unique()}@test.local`;
    await db
      .insertInto("invitations")
      .values({
        institution_id: s.institutionId,
        email,
        role: "student",
        expires_at: new Date(Date.now() + 86_400_000),
      })
      .execute();
    const { res } = await launch({ sub: `lms-${unique()}`, email: email.toUpperCase(), roles: [ROLES.learner] });
    expect(res.statusCode).toBe(302);
    expect(nextOf(res.headers.location as string)).toEqual({ tokenHash: `hash-${email}`, next: `/i/${s.slug}` });
    expect(created).toContain(email);
    // Their invitation is accepted at once, so they can join LMS courses in the same launch.
    const member = await db
      .selectFrom("institution_memberships as m")
      .innerJoin("profiles as p", "p.id", "m.user_id")
      .select("m.role")
      .where("m.institution_id", "=", s.institutionId)
      .where("p.email", "=", email)
      .executeTakeFirst();
    expect(member?.role).toBe("student");
  });

  it("queues unknown LMS users for an admin, who links or refuses them", async () => {
    const stranger = { sub: `lms-${unique()}`, email: `stranger-${unique()}@test.local`, roles: [ROLES.learner] };
    const first = await launch(stranger);
    expect(first.res.statusCode).toBe(302);
    expect(first.res.headers.location).toMatch(new RegExp(`^${settings.env.APP_URL}/lti/pending\\?institution=`));
    const pending = await db
      .selectFrom("lms_user_links")
      .select(["id", "status", "profile_id"])
      .where("lms_user_id", "=", stranger.sub)
      .executeTakeFirstOrThrow();
    expect(pending).toMatchObject({ status: "pending", profile_id: null });

    const resolve = (userId: string, payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url: `/v1/lms-user-links/${pending.id}/resolve`, headers: as(userId), payload });
    expect((await resolve(s.instructor, { action: "reject" })).statusCode).toBe(403);
    const outsider = await fixtures.user();
    expect((await resolve(admin, { action: "link", profileId: outsider })).statusCode).toBe(409);

    // Linked to a member (one LMS account each), the next launch signs them in as that member.
    expect((await resolve(admin, { action: "link", profileId: s.otherStudent })).statusCode).toBe(409);
    const member = await fixtures.user();
    await db
      .insertInto("institution_memberships")
      .values({ institution_id: s.institutionId, user_id: member, role: "student", external_id: null })
      .execute();
    expect((await resolve(admin, { action: "link", profileId: member })).statusCode).toBe(200);
    const second = await launch(stranger);
    expect(nextOf(second.res.headers.location as string).tokenHash).toBe(`hash-${await emailOf(member)}`);

    // Refused, their launches are refused.
    expect((await resolve(admin, { action: "reject" })).statusCode).toBe(200);
    const third = await launch(stranger);
    expect(third.res.statusCode).toBe(403);
    expect(third.res.body).toContain("can&#39;t be used to sign in");
  });

  it("refuses launches that don't verify, and opens a new tab from inside an iframe", async () => {
    const user = { sub: `lms-${unique()}`, email: await emailOf(s.student), roles: [ROLES.learner] };
    const wrongNonce = await launch(user, {}, { nonce: "not-the-login-nonce" });
    expect(wrongNonce.res.statusCode).toBe(400);
    expect(wrongNonce.res.body).toContain("nonce");

    const framed = await launch(user, { headers: { "sec-fetch-dest": "iframe" } });
    expect(framed.res.statusCode).toBe(200);
    expect(framed.res.body).toMatch(
      /<a id="continue" href="http:\/\/localhost:3000\/auth\/lti\?token_hash=[^"]+" target="_blank"/,
    );

    const deepLink = await launch({ ...user, roles: [ROLES.instructor] }, {}, { messageType: "LtiDeepLinkingRequest" });
    expect(deepLink.res.statusCode).toBe(501);

    // A connection that's turned off stops launches.
    const off = await app.inject({
      method: "PATCH",
      url: `/v1/lms-connections/${connectionId}`,
      headers: as(admin),
      payload: { status: "disabled" },
    });
    expect(off.statusCode).toBe(200);
    const login = await app.inject({
      method: "GET",
      url: `/lti/login?${new URLSearchParams({ iss: platform.issuer, login_hint: "x", target_link_uri: "https://x.test", client_id: CLIENT_ID })}`,
    });
    expect(login.statusCode).toBe(400);
    await db.updateTable("lms_connections").set({ status: "active" }).where("id", "=", connectionId).execute();
  });
});

describe("LTI Dynamic Registration", () => {
  let lms: Server;
  let lmsUrl: string;
  const registrations: { auth: string | undefined; body: Record<string, unknown> }[] = [];

  beforeAll(async () => {
    // A platform's OpenID configuration and registration endpoint.
    lms = createServer((req, res) => {
      if (req.url === "/.well-known/openid-configuration") {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            issuer: lmsUrl,
            authorization_endpoint: `${lmsUrl}/auth`,
            token_endpoint: `${lmsUrl}/token`,
            jwks_uri: `${lmsUrl}/jwks`,
            registration_endpoint: `${lmsUrl}/register`,
            "https://purl.imsglobal.org/spec/lti-platform-configuration": { product_family_code: "moodle" },
          }),
        );
        return;
      }
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString()));
      req.on("end", () => {
        registrations.push({ auth: req.headers.authorization, body: JSON.parse(raw) as Record<string, unknown> });
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            client_id: `moodle-${unique()}`,
            "https://purl.imsglobal.org/spec/lti-tool-configuration": { deployment_id: "7" },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => lms.listen(0, "127.0.0.1", resolve));
    lmsUrl = `http://127.0.0.1:${(lms.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => lms.close(() => resolve())));

  it("registers with the LMS through an admin's one-time URL", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/v1/institutions/${s.institutionId}/lti-registrations`,
      headers: as(admin),
      payload: { type: "moodle", name: "Moodle" },
    });
    expect(created.statusCode).toBe(201);
    const inviteUrl = new URL(created.json().url as string);
    expect(inviteUrl.origin + inviteUrl.pathname).toBe(`${settings.env.API_URL}/lti/register`);
    const register = () =>
      app.inject({
        method: "GET",
        url: `/lti/register?${new URLSearchParams({
          invite: inviteUrl.searchParams.get("invite")!,
          openid_configuration: `${lmsUrl}/.well-known/openid-configuration`,
          registration_token: "reg-token",
        })}`,
      });

    const res = await register();
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("org.imsglobal.lti.close");
    expect(registrations.at(-1)!.auth).toBe("Bearer reg-token");
    expect(registrations.at(-1)!.body).toMatchObject({ initiate_login_uri: `${settings.env.API_URL}/lti/login` });
    const conn = await db
      .selectFrom("lms_connections")
      .select(["type", "name", "issuer", "deployment_ids", "registered_by", "jwks_url"])
      .where("institution_id", "=", s.institutionId)
      .where("registered_by", "=", "dynamic")
      .executeTakeFirstOrThrow();
    expect(conn).toEqual({
      type: "moodle",
      name: "Moodle",
      issuer: lmsUrl,
      deployment_ids: ["7"],
      registered_by: "dynamic",
      jwks_url: `${lmsUrl}/jwks`,
    });

    // The URL works once.
    const again = await register();
    expect(again.statusCode).toBe(400);
    expect(again.body).toContain("already used");

    // Teachers can't make registration URLs.
    const teacher = await app.inject({
      method: "POST",
      url: `/v1/institutions/${s.institutionId}/lti-registrations`,
      headers: as(s.instructor),
      payload: { type: "moodle", name: "Moodle" },
    });
    expect(teacher.statusCode).toBe(403);
  });
});
