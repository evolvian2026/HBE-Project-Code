import { describe, expect, it } from "vitest";
import {
  authRedirectUrl,
  courseRoleFromLti,
  generateToolKey,
  registerWithPlatform,
  toolJwks,
  verifyLaunch,
  type LtiError,
  type Platform,
} from "./index.ts";
import { ROLES, TestPlatform } from "./testing.ts";

const platformFor = (p: TestPlatform): Platform => ({
  issuer: p.issuer,
  clientId: "client-1",
  deploymentIds: ["dep-1"],
  authLoginUrl: `${p.issuer}/auth`,
  authTokenUrl: `${p.issuer}/token`,
  jwksUrl: `${p.issuer}/jwks`,
});
const student = { sub: "u-1", email: "Ada@Example.test", name: "Ada Lovelace", roles: [ROLES.learner] };

describe("launch verification", () => {
  it("accepts a valid resource link launch and reads its claims", async () => {
    const p = await TestPlatform.create();
    const token = await p.idToken({
      user: student,
      nonce: "n-1",
      clientId: "client-1",
      deploymentId: "dep-1",
      context: { id: "ctx-1", title: "Web Development" },
      resourceLink: { id: "rl-1", title: "Todo API" },
      custom: { assignment_id: "a-1" },
      extra: {
        "https://purl.imsglobal.org/spec/lti-nrps/claim/namesroleservice": {
          context_memberships_url: "https://lms.test/nrps",
        },
      },
    });
    const launch = await verifyLaunch(token, platformFor(p), { nonce: "n-1", jwks: p.localJwks });
    expect(launch).toMatchObject({
      messageType: "LtiResourceLinkRequest",
      userId: "u-1",
      email: "ada@example.test",
      name: "Ada Lovelace",
      courseRole: "student",
      context: { id: "ctx-1", title: "Web Development" },
      resourceLink: { id: "rl-1", title: "Todo API" },
      custom: { assignment_id: "a-1" },
      nrps: { membershipsUrl: "https://lms.test/nrps" },
    });
  });

  it("rejects tokens that aren't for this login, tool, deployment or version", async () => {
    const p = await TestPlatform.create();
    const other = await TestPlatform.create(p.issuer);
    const base = { user: student, nonce: "n-1", clientId: "client-1", deploymentId: "dep-1" };
    const code = async (token: string, nonce = "n-1") =>
      verifyLaunch(token, platformFor(p), { nonce, jwks: p.localJwks }).then(
        () => "ok",
        (err: LtiError) => err.code,
      );
    expect(await code(await p.idToken(base), "n-2")).toBe("invalid_nonce");
    expect(await code(await p.idToken({ ...base, clientId: "someone-else" }))).toBe("invalid_token");
    expect(await code(await p.idToken({ ...base, deploymentId: "dep-9" }))).toBe("unknown_deployment");
    // A connection that lists no deployments accepts any deployment of its client.
    const anyDeployment = { ...platformFor(p), deploymentIds: [] };
    const token = await p.idToken({ ...base, deploymentId: "dep-9" });
    expect((await verifyLaunch(token, anyDeployment, { nonce: "n-1", jwks: p.localJwks })).deploymentId).toBe("dep-9");
    expect(await code(await other.idToken(base))).toBe("invalid_token"); // signed by another key
    expect(await code(await p.idToken({ ...base, expiresInSeconds: -120 }))).toBe("invalid_token");
    expect(
      await code(await p.idToken({ ...base, extra: { "https://purl.imsglobal.org/spec/lti/claim/version": "1.1" } })),
    ).toBe("unsupported_version");
  });
});

describe("roles", () => {
  it("map LMS roles to course roles", () => {
    expect(courseRoleFromLti([ROLES.instructor])).toBe("instructor");
    expect(courseRoleFromLti([ROLES.ta, ROLES.instructor])).toBe("ta");
    expect(courseRoleFromLti(["Learner"])).toBe("student");
    expect(courseRoleFromLti([ROLES.admin])).toBeNull();
  });
});

describe("OIDC login", () => {
  it("redirects to the platform with the login hint, state and nonce", () => {
    const url = new URL(
      authRedirectUrl(
        { ...platformFor({ issuer: "https://lms.test" } as TestPlatform) },
        {
          iss: "https://lms.test",
          login_hint: "hint",
          target_link_uri: "https://api.test/lti/launch",
          lti_message_hint: "m",
        },
        { redirectUri: "https://api.test/lti/launch", state: "s", nonce: "n" },
      ),
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      scope: "openid",
      response_type: "id_token",
      response_mode: "form_post",
      prompt: "none",
      client_id: "client-1",
      redirect_uri: "https://api.test/lti/launch",
      login_hint: "hint",
      lti_message_hint: "m",
      state: "s",
      nonce: "n",
    });
  });
});

describe("tool keys", () => {
  it("publish only public parts", async () => {
    const key = await generateToolKey("k1");
    const [jwk] = toolJwks({ current: key }).keys;
    expect(jwk).toMatchObject({ kid: "k1", alg: "RS256", use: "sig", kty: "RSA" });
    expect(jwk).not.toHaveProperty("d");
  });
});

describe("dynamic registration", () => {
  it("reads the platform's configuration and registers the tool", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/openid-configuration")) {
        return Response.json({
          issuer: "https://moodle.test",
          authorization_endpoint: "https://moodle.test/mod/lti/auth.php",
          token_endpoint: "https://moodle.test/mod/lti/token.php",
          jwks_uri: "https://moodle.test/mod/lti/certs.php",
          registration_endpoint: "https://moodle.test/mod/lti/openid-registration.php",
          "https://purl.imsglobal.org/spec/lti-platform-configuration": { product_family_code: "moodle" },
        });
      }
      return Response.json({
        client_id: "moodle-client",
        "https://purl.imsglobal.org/spec/lti-tool-configuration": { deployment_id: "7" },
      });
    }) as unknown as typeof fetch;
    const reg = await registerWithPlatform(
      "https://moodle.test/mod/lti/openid-configuration",
      "reg-token",
      { name: "HBE Projects", description: "Project grading", apiUrl: "https://api.example.com" },
      fakeFetch,
    );
    expect(reg).toMatchObject({
      issuer: "https://moodle.test",
      clientId: "moodle-client",
      deploymentId: "7",
      jwksUrl: "https://moodle.test/mod/lti/certs.php",
      productFamily: "moodle",
    });
    const body = JSON.parse(String(calls[1]!.init!.body));
    expect(body).toMatchObject({
      initiate_login_uri: "https://api.example.com/lti/login",
      redirect_uris: ["https://api.example.com/lti/launch"],
      jwks_uri: "https://api.example.com/.well-known/jwks.json",
    });
    expect((calls[1]!.init!.headers as Record<string, string>).authorization).toBe("Bearer reg-token");

    // A configuration served from somewhere other than its issuer is refused.
    const tool = { name: "x", description: "x", apiUrl: "https://api.example.com" };
    for (const elsewhere of [
      "https://evil.test/openid-configuration",
      "https://moodle.test.evil.test/openid-configuration",
    ]) {
      await expect(registerWithPlatform(elsewhere, null, tool, fakeFetch)).rejects.toThrow(/issuer/);
    }
    // Except Canvas, whose schools serve it from their own domains under one shared issuer.
    const canvasFetch = (async (url: string) =>
      url.endsWith("/openid-configuration")
        ? Response.json({
            issuer: "https://canvas.instructure.com",
            authorization_endpoint: "https://sso.canvaslms.com/api/lti/authorize_redirect",
            token_endpoint: "https://sso.canvaslms.com/login/oauth2/token",
            jwks_uri: "https://sso.canvaslms.com/api/lti/security/jwks",
            registration_endpoint: "https://school.instructure.com/api/lti/registrations",
            "https://purl.imsglobal.org/spec/lti-platform-configuration": { product_family_code: "canvas" },
          })
        : Response.json({ client_id: "10000000000001" })) as unknown as typeof fetch;
    const canvas = await registerWithPlatform(
      "https://school.instructure.com/api/lti/security/openid-configuration",
      "t",
      tool,
      canvasFetch,
    );
    expect(canvas).toMatchObject({
      issuer: "https://canvas.instructure.com",
      clientId: "10000000000001",
      deploymentId: null,
    });
  });
});
