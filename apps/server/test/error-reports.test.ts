import type { JobQueue } from "@hbe/queue";
import type { FastifyBaseLogger } from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { createErrorReporter, type ErrorReporter } from "../src/error-reports.ts";
import { jobMetrics } from "../src/metrics.ts";
import { observedQueue } from "../src/worker/observe.ts";
import { FakeQueue, FakeVerifier, testDb, testSettings } from "./helpers.ts";

const db = testDb();
afterAll(() => db.destroy());

const recorder = () => {
  const captured: { error: unknown; context?: Record<string, unknown> }[] = [];
  const reporter: ErrorReporter = {
    capture: (error, context) => captured.push({ error, context }),
    flush: async () => {},
  };
  return { captured, reporter };
};

describe("unexpected errors", () => {
  it("in the API are reported with the request id, and answered without details", async () => {
    const { captured, reporter } = recorder();
    const app = await buildApp({
      settings: testSettings(),
      db,
      queue: new FakeQueue(),
      verifier: new FakeVerifier(),
      errors: reporter,
    });
    app.get("/v1/boom", async () => {
      throw new Error("database exploded at secret.internal:5432");
    });
    const res = await app.inject({ method: "GET", url: "/v1/boom", headers: { "x-request-id": "req-boom-123" } });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "internal_error", message: "Something went wrong" });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.context).toEqual({ request_id: "req-boom-123", route: "/v1/boom" });
    await app.close();
  });

  it("in background jobs are logged, counted and reported, and the job still fails", async () => {
    const { captured, reporter } = recorder();
    const logged: unknown[] = [];
    const log = { error: (obj: unknown) => logged.push(obj) } as unknown as FastifyBaseLogger;
    let handler: ((job: { id: string; name: string; data: unknown }) => Promise<void>) | undefined;
    const inner = {
      work: async (_name: string, h: typeof handler) => void (handler = h),
    } as unknown as JobQueue;
    await observedQueue(inner, log, reporter).work("email-outbox", async () => {
      throw new Error("smtp down");
    });
    await expect(handler!({ id: "job-1", name: "email-outbox", data: {} })).rejects.toThrow("smtp down");
    expect(logged).toEqual([expect.objectContaining({ job: "email-outbox", job_id: "job-1" })]);
    expect(captured[0]!.context).toEqual({ job: "email-outbox", job_id: "job-1" });
    expect(jobMetrics.render().join("\n")).toMatch(/hbe_jobs_total\{queue="email-outbox",outcome="failed"\} [1-9]/);
  });

  it("are sent to Sentry without request data or personal details", async () => {
    const sent: string[] = [];
    const reporter = await createErrorReporter(testSettings({ SENTRY_DSN: "https://public@sentry.example/1" }), () => ({
      send: async (envelope) => {
        sent.push(JSON.stringify(envelope));
        return {};
      },
      flush: async () => true,
    }));
    const { getCurrentScope } = await import("@sentry/node");
    getCurrentScope().setUser({ id: "user-1", email: "ada@example.com", ip_address: "1.2.3.4" });
    getCurrentScope().setExtra("body", { password: "hunter2" });
    reporter.capture(new Error("boom"), { job: "email-outbox" });
    await reporter.flush(2000);
    expect(sent).toHaveLength(1);
    const event = sent[0]!;
    expect(event).toContain("boom");
    expect(event).toContain('"job":"email-outbox"');
    expect(event).toContain('"id":"user-1"');
    for (const secret of ["ada@example.com", "1.2.3.4", "hunter2"]) expect(event).not.toContain(secret);
  });
});
