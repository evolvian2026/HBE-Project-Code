import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { redactUrl } from "../src/security.ts";
import { FakeQueue, FakeVerifier, Fixtures, testDb, testSettings } from "./helpers.ts";

const db = testDb();
const fixtures = new Fixtures(db);
const verifier = new FakeVerifier();
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({
    settings: testSettings(),
    db,
    queue: new FakeQueue(),
    verifier,
    rateLimits: {
      api: {
        max: 3,
        windowMs: 60_000,
        key: (req) => (req.url.startsWith("/v1/") ? `api:${req.headers.authorization ?? req.ip}` : null),
      },
    },
  });
});
afterAll(async () => {
  await app.close();
  await fixtures.cleanup();
  await db.destroy();
});

describe("API responses", () => {
  it("carry security headers, and only LTI pages may be framed", async () => {
    const health = await app.inject({ method: "GET", url: "/healthz" });
    expect(health.headers).toMatchObject({
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    });

    const user = await fixtures.user();
    const me = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${verifier.tokenFor(user)}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.headers["cache-control"]).toBe("no-store");

    const lti = await app.inject({ method: "GET", url: "/lti/register" });
    expect(lti.headers["content-type"]).toContain("text/html");
    expect(lti.headers["x-frame-options"]).toBeUndefined();
    expect(lti.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("are rate limited per credential", async () => {
    const [a, b] = [await fixtures.user(), await fixtures.user()];
    const tokens = new Map([a, b].map((u) => [u, verifier.tokenFor(u)]));
    const get = (user: string) =>
      app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${tokens.get(user)}` } });
    for (let i = 0; i < 3; i++) expect((await get(a)).statusCode).toBe(200);
    const limited = await get(a);
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: "rate_limited" });
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect((await get(b)).statusCode).toBe(200); // someone else isn't affected
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200); // nor unlimited routes
  });
});

describe("request logs", () => {
  it("leave out one-time codes, invites and tokens", () => {
    expect(redactUrl("/v1/google/callback?code=4/abc&state=xyz&scope=email")).toBe(
      "/v1/google/callback?code=%5Bredacted%5D&state=%5Bredacted%5D&scope=email",
    );
    expect(redactUrl("/lti/register?invite=secret&openid_configuration=https://lms.test/c")).toBe(
      "/lti/register?invite=%5Bredacted%5D&openid_configuration=https%3A%2F%2Flms.test%2Fc",
    );
    expect(redactUrl("/v1/me")).toBe("/v1/me");
    expect(redactUrl("/v1/courses?page=2")).toBe("/v1/courses?page=2");
  });
});
