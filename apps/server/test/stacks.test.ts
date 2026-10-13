import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { stackDefinitionSchema } from "../src/stack-definition.ts";
import { FakeQueue, FakeVerifier, Fixtures, testDb, testSettings, unique } from "./helpers.ts";

const db = testDb();
const fixtures = new Fixtures(db);
const verifier = new FakeVerifier();
let app: FastifyInstance;
const stacksDir = resolve(import.meta.dirname, "../../../grader/stacks");
const mern = JSON.parse(readFileSync(resolve(stacksDir, "mern-node20.json"), "utf8")) as Record<string, unknown>;

beforeAll(async () => {
  app = await buildApp({ settings: testSettings(), db, queue: new FakeQueue(), verifier });
});
afterAll(async () => {
  await app.close();
  await fixtures.cleanup();
  await db.destroy();
});

const call = (method: "POST" | "PATCH" | "PUT", url: string, userId: string, payload: object) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${verifier.tokenFor(userId)}` }, payload });

describe("stack profile definitions", () => {
  it("accept the profiles the grader ships with", () => {
    for (const file of readdirSync(stacksDir).filter((f) => f.endsWith(".json"))) {
      const def = JSON.parse(readFileSync(resolve(stacksDir, file), "utf8"));
      expect(stackDefinitionSchema.safeParse(def).success, file).toBe(true);
    }
  });

  it("refuse what the grader couldn't run safely or at all", () => {
    const bad = (patch: Record<string, unknown>) => stackDefinitionSchema.safeParse({ ...mern, ...patch }).success;
    expect(bad({ detect: ["/etc/passwd"] })).toBe(false);
    expect(bad({ detect: ["../outside"] })).toBe(false);
    expect(bad({ services: {} })).toBe(false);
    expect(bad({ datastores: ["not an image!"] })).toBe(false);
    expect(bad({ env_required: ["lower_case"] })).toBe(false);
    expect(bad({ surprise: true })).toBe(false);
    expect(
      bad({
        detect: Array.from({ length: 20 }, () => "d".repeat(300)),
        ignore_paths: Array.from({ length: 50 }, () => "x".repeat(200)),
      }),
    ).toBe(false); // over 16 KB
  });
});

describe("stack profiles and test suites", () => {
  it("institution admins add versions of their own profiles, retire them and choose the global ones offered", async () => {
    const admin = await fixtures.user();
    const teacher = await fixtures.user();
    const inst = await fixtures.institution([
      { userId: admin, role: "admin" },
      { userId: teacher, role: "teacher" },
    ]);
    const key = `spring-${unique()}`;
    const add = (userId: string, payload: object) =>
      call("POST", `/v1/institutions/${inst.id}/stack-profiles`, userId, payload);
    const profile = { key, displayName: "Spring Boot", definition: mern };

    expect((await add(teacher, profile)).statusCode).toBe(403);
    expect((await add(admin, { ...profile, key: "mern-node20" })).json()).toMatchObject({ error: "key_taken" });
    expect((await add(admin, { ...profile, definition: { ...mern, services: {} } })).statusCode).toBe(400);
    const v1 = await add(admin, profile);
    expect(v1.statusCode).toBe(201);
    expect(v1.json()).toMatchObject({ key, version: 1 });
    expect((await add(admin, { ...profile, displayName: "Spring Boot 3" })).json()).toMatchObject({ version: 2 });
    const stored = await db
      .selectFrom("stack_profiles")
      .selectAll()
      .where("id", "=", v1.json().id)
      .executeTakeFirstOrThrow();
    expect(stored).toMatchObject({ institution_id: inst.id, status: "active", definition: mern });

    expect((await call("PATCH", `/v1/stack-profiles/${v1.json().id}`, teacher, { status: "retired" })).statusCode).toBe(
      403,
    );
    expect((await call("PATCH", `/v1/stack-profiles/${v1.json().id}`, admin, { status: "retired" })).json()).toEqual({
      id: v1.json().id,
      status: "retired",
    });
    const global = await db
      .selectFrom("stack_profiles")
      .select("id")
      .where("institution_id", "is", null)
      .where("key", "=", "django-react")
      .executeTakeFirstOrThrow();
    // Global profiles are the platform's to retire.
    expect((await call("PATCH", `/v1/stack-profiles/${global.id}`, admin, { status: "retired" })).statusCode).toBe(403);

    const offered = (hidden: string[]) =>
      call("PUT", `/v1/institutions/${inst.id}/offered-profiles`, admin, { hidden });
    expect((await offered([v1.json().id])).statusCode).toBe(404); // not a global profile
    expect((await offered([global.id])).json()).toEqual({ hidden: [global.id] });
    const settings = await db
      .selectFrom("institutions")
      .select("settings")
      .where("id", "=", inst.id)
      .executeTakeFirstOrThrow();
    expect(settings.settings).toMatchObject({ hidden_stack_profiles: [global.id] });

    const audit = await db
      .selectFrom("audit_logs")
      .select(["entity", "action", "actor_id"])
      .where("institution_id", "=", inst.id)
      .where("entity", "=", "stack_profiles")
      .execute();
    expect(audit).toEqual(
      expect.arrayContaining([
        { entity: "stack_profiles", action: "insert", actor_id: admin },
        { entity: "stack_profiles", action: "update", actor_id: admin },
      ]),
    );
  });

  it("the platform operator registers suite versions; institution admins retire their own", async () => {
    const operator = await fixtures.user({ superAdmin: true });
    const admin = await fixtures.user();
    const inst = await fixtures.institution([{ userId: admin, role: "admin" }]);
    const key = `shop-${unique()}`;
    const register = (userId: string, payload: object) => call("POST", "/v1/platform/grader-suites", userId, payload);
    const suite = { institutionId: inst.id, key, title: "Shop API", path: "suites/acme/shop" };

    expect((await register(admin, suite)).statusCode).toBe(403);
    expect((await register(operator, { ...suite, path: "../escape" })).statusCode).toBe(400);
    const v1 = await register(operator, suite);
    expect(v1.json()).toMatchObject({ key, version: 1 });
    expect((await register(operator, { ...suite, gitRef: "v2" })).json()).toMatchObject({ version: 2 });
    const row = await db
      .selectFrom("grader_suites")
      .selectAll()
      .where("id", "=", v1.json().id)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ institution_id: inst.id, path: "suites/acme/shop", git_ref: "main", status: "active" });

    expect((await call("PATCH", `/v1/grader-suites/${v1.json().id}`, admin, { status: "retired" })).json()).toEqual({
      id: v1.json().id,
      status: "retired",
    });
    const global = await db
      .selectFrom("grader_suites")
      .select("id")
      .where("institution_id", "is", null)
      .where("key", "=", "todo-api")
      .executeTakeFirstOrThrow();
    expect((await call("PATCH", `/v1/grader-suites/${global.id}`, admin, { status: "retired" })).statusCode).toBe(403);
  });
});
