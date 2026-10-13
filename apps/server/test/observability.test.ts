import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { FakeQueue, FakeVerifier, Fixtures, testDb, testSettings } from "./helpers.ts";

const TOKEN = "metrics-token-for-tests-0123456789";
const db = testDb();
const fixtures = new Fixtures(db);
const verifier = new FakeVerifier();
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({
    settings: testSettings({ METRICS_TOKEN: TOKEN }),
    db,
    queue: new FakeQueue(),
    verifier,
  });
});
afterAll(async () => {
  await app.close();
  await fixtures.cleanup();
  await db.destroy();
});

describe("request ids", () => {
  it("are taken from the caller when well formed, or made up, and sent back", async () => {
    const given = await app.inject({ method: "GET", url: "/healthz", headers: { "x-request-id": "page-1234abcd" } });
    expect(given.headers["x-request-id"]).toBe("page-1234abcd");
    const made = await app.inject({ method: "GET", url: "/healthz", headers: { "x-request-id": "bad id\n" } });
    expect(made.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("GET /metrics", () => {
  it("needs the metrics token", async () => {
    expect((await app.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(401);
    const wrong = await app.inject({ method: "GET", url: "/metrics", headers: { authorization: "Bearer nope" } });
    expect(wrong.statusCode).toBe(401);
  });

  it("reports traffic by route template, and the platform's queues and runs", async () => {
    const user = await fixtures.user();
    const token = verifier.tokenFor(user);
    await app.inject({ method: "GET", url: "/v1/me", headers: { authorization: `Bearer ${token}` } });
    await app.inject({ method: "GET", url: "/v1/institutions/00000000-0000-0000-0000-000000000000/usage" });

    const res = await app.inject({ method: "GET", url: "/metrics", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain; version=0.0.4");
    const text = res.body;
    expect(text).toMatch(/hbe_http_requests_total\{method="GET",route="\/v1\/me",status="2xx"\} [1-9]/);
    // Route templates, not ids.
    expect(text).toContain('route="/v1/institutions/:institutionId/usage",status="4xx"');
    expect(text).not.toContain("00000000-0000");
    expect(text).toMatch(/hbe_http_request_duration_seconds_bucket\{method="GET",route="\/v1\/me",le="0.3"\} \d+/);
    expect(text).toMatch(/hbe_http_request_duration_seconds_count\{method="GET",route="\/v1\/me"\} [1-9]/);
    expect(text).not.toContain('route="/metrics"');
    for (const name of [
      'hbe_runs{state="queued"}',
      "hbe_runs_concurrency_limit",
      "hbe_webhooks_unprocessed",
      "hbe_runner_minutes_budget",
      "hbe_event_loop_delay_p99_seconds",
      "hbe_process_resident_memory_bytes",
    ]) {
      expect(text).toContain(name);
    }
  });

  it("doesn't exist without a token configured", async () => {
    const plain = await buildApp({ settings: testSettings(), db, queue: new FakeQueue(), verifier });
    expect((await plain.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(404);
    await plain.close();
  });
});
