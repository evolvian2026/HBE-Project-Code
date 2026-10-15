import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { institutionAddresses, renderProvisioner, type DomainProvisioner, type TxtResolver } from "../src/domains.ts";
import type { SignInService } from "../src/lti/sign-in.ts";
import { sweepRetention } from "../src/worker/retention.ts";
import { MemoryObjectStore } from "../src/storage.ts";
import { FakeQueue, FakeVerifier, Fixtures, testDb, testSettings, unique } from "./helpers.ts";

const db = testDb();
const fixtures = new Fixtures(db);
const verifier = new FakeVerifier();
const settings = testSettings({ INSTITUTION_BASE_DOMAIN: "localhost", CUSTOM_DOMAIN_TARGET: "domains.hbe.test" });

/** DNS in memory: TXT records by name. */
const txt = new Map<string, string[][]>();
const resolveTxt: TxtResolver = async (name) => txt.get(name) ?? [];

/** The hosting in memory: added domains become live when `issue` is called. */
class FakeProvisioner implements DomainProvisioner {
  readonly mode = "render" as const;
  readonly live = new Set<string>();
  readonly added: string[] = [];
  readonly removed: string[] = [];
  async add(hostname: string) {
    this.added.push(hostname);
    return { providerId: `cdm-${hostname}` };
  }
  async status(hostname: string) {
    return this.live.has(hostname) ? ("active" as const) : ("provisioning" as const);
  }
  async remove(hostname: string) {
    this.removed.push(hostname);
  }
}
const provisioner = new FakeProvisioner();
const signIns: string[] = [];
const signIn: SignInService = {
  async createUser() {
    throw new Error("unused");
  },
  async signInToken(email) {
    signIns.push(email);
    return `token-for-${email}`;
  },
};

let app: FastifyInstance;
let admin: string;
let teacher: string;
let inst: { id: string; slug: string };

beforeAll(async () => {
  app = await buildApp({ settings, db, queue: new FakeQueue(), verifier, provisioner, resolveTxt, signIn });
  admin = await fixtures.user({ email: `admin-${unique()}@test.local` });
  teacher = await fixtures.user();
  inst = await fixtures.institution([
    { userId: admin, role: "admin" },
    { userId: teacher, role: "teacher" },
  ]);
});
afterAll(async () => {
  await app.close();
  await fixtures.cleanup();
  await db.destroy();
});

const call = (method: "GET" | "PUT" | "POST" | "DELETE", url: string, userId?: string, payload?: object) =>
  app.inject({
    method,
    url,
    headers: userId ? { authorization: `Bearer ${verifier.tokenFor(userId)}` } : {},
    ...(payload ? { payload } : {}),
  });

describe("institution addresses", () => {
  it("show the subdomain, and let only admins add a vanity domain", async () => {
    expect((await call("GET", `/v1/institutions/${inst.id}/address`, teacher)).statusCode).toBe(403);
    const res = await call("GET", `/v1/institutions/${inst.id}/address`, admin);
    expect(res.json()).toEqual({
      platformUrl: `http://localhost:3000/i/${inst.slug}`,
      subdomainUrl: `http://${inst.slug}.localhost:3000`,
      domain: null,
      target: "domains.hbe.test",
      provisioner: "render",
    });
    expect(
      (await call("PUT", `/v1/institutions/${inst.id}/domain`, teacher, { hostname: "x.example.edu" })).statusCode,
    ).toBe(403);
    expect(
      (await call("PUT", `/v1/institutions/${inst.id}/domain`, admin, { hostname: "not a domain" })).json(),
    ).toMatchObject({
      error: "invalid_hostname",
    });
    expect(
      (await call("PUT", `/v1/institutions/${inst.id}/domain`, admin, { hostname: "acme.localhost" })).json(),
    ).toMatchObject({
      error: "not_allowed",
    });
  });

  it("verify the domain with its TXT record, have the hosting add it, and serve it once live", async () => {
    const hostname = `projects-${unique()}.example.edu`;
    const added = await call("PUT", `/v1/institutions/${inst.id}/domain`, admin, {
      hostname: `https://${hostname.toUpperCase()}/`,
    });
    expect(added.statusCode).toBe(201);
    const { record } = added.json().domain;
    expect(record.name).toBe(`_hbe-verify.${hostname}`);
    expect(record.value).toMatch(/^hbe-verify=[\w-]{20,}$/);
    // One per institution, and one institution per domain.
    expect(
      (await call("PUT", `/v1/institutions/${inst.id}/domain`, admin, { hostname: "other.example.edu" })).json(),
    ).toMatchObject({
      error: "domain_exists",
    });

    // Without the record: still pending, with what's missing.
    let check = (await call("POST", `/v1/institutions/${inst.id}/domain/check`, admin)).json().domain;
    expect(check).toMatchObject({ status: "pending", error: expect.stringContaining("No matching TXT record") });
    expect((await call("GET", `/v1/hosts/${hostname}`)).statusCode).toBe(404);

    // The record appears (split into strings, as DNS may): the hosting adds the domain.
    txt.set(record.name, [[record.value.slice(0, 10), record.value.slice(10)]]);
    check = (await call("POST", `/v1/institutions/${inst.id}/domain/check`, admin)).json().domain;
    expect(check).toMatchObject({ status: "provisioning", error: null });
    expect(provisioner.added).toEqual([hostname]);
    expect((await call("GET", `/v1/hosts/${hostname}`)).statusCode).toBe(404);

    // The certificate is issued: live, and links use it.
    provisioner.live.add(hostname);
    check = (await call("POST", `/v1/institutions/${inst.id}/domain/check`, admin)).json().domain;
    expect(check.status).toBe("active");
    expect((await call("GET", `/v1/hosts/${hostname}`)).json()).toEqual({ slug: inst.slug });
    expect((await call("GET", `/v1/hosts/${hostname.toUpperCase()}:443`)).json()).toEqual({ slug: inst.slug });
    expect(await institutionAddresses(db, settings).forSlug(inst.slug)).toBe(`http://${hostname}:3000`);

    // Removing it takes it off the hosting.
    expect((await call("DELETE", `/v1/institutions/${inst.id}/domain`, admin)).statusCode).toBe(204);
    expect(provisioner.removed).toEqual([hostname]);
    expect((await call("GET", `/v1/hosts/${hostname}`)).statusCode).toBe(404);
    expect(await institutionAddresses(db, settings).forId(inst.id)).toBe(`http://${inst.slug}.localhost:3000`);
  });

  it("let Caddy get certificates for institutions' addresses only", async () => {
    expect((await call("GET", `/v1/hosts/tls-check?domain=${inst.slug}.localhost`)).statusCode).toBe(200);
    expect((await call("GET", "/v1/hosts/tls-check?domain=attacker.example.com")).statusCode).toBe(404);
    expect((await call("GET", "/v1/hosts/tls-check")).statusCode).toBe(404);
  });

  it("serve institutions' subdomains, and nothing else", async () => {
    expect((await call("GET", `/v1/hosts/${inst.slug}.localhost:3000`)).json()).toEqual({ slug: inst.slug });
    expect((await call("GET", `/v1/hosts/no-such-place.localhost`)).statusCode).toBe(404);
    expect((await call("GET", `/v1/hosts/localhost:3000`)).statusCode).toBe(404);
    expect((await call("GET", `/v1/hosts/www.localhost`)).statusCode).toBe(404);
  });
});

describe("signing in on an institution's address", () => {
  it("hands the signed-in person over once, for that host only, within a minute", async () => {
    const host = `${inst.slug}.localhost:3000`;
    expect((await call("POST", "/v1/auth/handoffs", undefined, { to: `http://${host}/` })).statusCode).toBe(401);
    expect((await call("POST", "/v1/auth/handoffs", teacher, { to: "http://evil.example.com/" })).json()).toMatchObject(
      { error: "invalid_host" },
    );

    const res = await call("POST", "/v1/auth/handoffs", teacher, { to: `http://${host}/courses?tab=mine` });
    const url = new URL(res.json().url);
    expect(`${url.origin}${url.pathname}`).toBe(`http://${host}/auth/handoff`);
    expect(url.searchParams.get("next")).toBe("/courses?tab=mine");
    const code = url.searchParams.get("code")!;

    // Another host can't use it.
    expect(
      (await call("POST", "/v1/auth/handoffs/redeem", undefined, { code, host: "other.localhost:3000" })).statusCode,
    ).toBe(400);
    const redeemed = await call("POST", "/v1/auth/handoffs/redeem", undefined, { code, host });
    expect(redeemed.json().tokenHash).toMatch(/^token-for-user-/);
    // Only once.
    expect((await call("POST", "/v1/auth/handoffs/redeem", undefined, { code, host })).json()).toMatchObject({
      error: "invalid_code",
    });

    // Expired codes don't work, and the retention sweep removes them.
    const late = new URL((await call("POST", "/v1/auth/handoffs", teacher, { to: `http://${host}/` })).json().url);
    await db
      .updateTable("session_handoffs")
      .set({ expires_at: new Date(Date.now() - 2 * 86_400_000) })
      .where("host", "=", host)
      .execute();
    expect(
      (await call("POST", "/v1/auth/handoffs/redeem", undefined, { code: late.searchParams.get("code")!, host }))
        .statusCode,
    ).toBe(400);
    const swept = await sweepRetention({ db, settings, store: new MemoryObjectStore(), archive: null });
    expect(swept.handoffs).toBeGreaterThanOrEqual(1);
  });
});

describe("the platform operator", () => {
  it("lists every vanity domain", async () => {
    const operator = await fixtures.user({ superAdmin: true });
    const res = await call("GET", "/v1/platform/domains", operator);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ provisioner: "render", target: "domains.hbe.test" });
    expect((await call("GET", "/v1/platform/domains", admin)).statusCode).toBe(403);
  });
});

describe("Render's custom domains API", () => {
  it("adds, checks and removes a domain", async () => {
    const calls: string[] = [];
    let verified = false;
    const fake = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url.replace("https://api.render.com/v1/services/srv-1", "")}`);
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer rnd_test");
      if (init?.method === "POST" && url.endsWith("/custom-domains")) {
        return new Response(
          JSON.stringify([{ id: "cdm-1", name: "p.example.edu", verificationStatus: "unverified" }]),
          {
            status: 201,
          },
        );
      }
      if (init?.method === "GET") {
        return new Response(JSON.stringify({ id: "cdm-1", verificationStatus: verified ? "verified" : "unverified" }));
      }
      return new Response(null, { status: init?.method === "DELETE" ? 204 : 202 });
    }) as typeof fetch;
    const render = renderProvisioner(
      testSettings({ DOMAIN_PROVISIONER: "render", RENDER_API_KEY: "rnd_test", RENDER_SERVICE_ID: "srv-1" }),
      fake,
    );
    expect(await render.add("p.example.edu")).toEqual({ providerId: "cdm-1" });
    expect(await render.status("p.example.edu", "cdm-1")).toBe("provisioning");
    verified = true;
    expect(await render.status("p.example.edu", "cdm-1")).toBe("active");
    await render.remove("p.example.edu", "cdm-1");
    expect(calls).toEqual([
      "POST /custom-domains",
      "GET /custom-domains/cdm-1",
      "POST /custom-domains/cdm-1/verify",
      "GET /custom-domains/cdm-1",
      "DELETE /custom-domains/cdm-1",
    ]);
  });
});
