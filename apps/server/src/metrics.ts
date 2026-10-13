import { timingSafeEqual } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { Db } from "@hbe/db";
import type { Settings } from "@hbe/settings";
import type { FastifyInstance } from "fastify";
import { platformHealth } from "./usage.ts";

/** Seconds; NFR-2's targets (300 ms API, 500 ms webhook acknowledgement) fall on bucket edges. */
const BUCKETS = [0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 2, 5];

interface Series {
  count: number;
  sum: number;
  buckets: number[];
}

/** Request counts and latencies by route template (never the raw URL, to keep labels few). */
export class HttpMetrics {
  private readonly requests = new Map<string, number>();
  private readonly durations = new Map<string, Series>();

  record(method: string, route: string, status: number, seconds: number): void {
    const statusClass = `${Math.floor(status / 100)}xx`;
    const key = JSON.stringify([method, route, statusClass]);
    this.requests.set(key, (this.requests.get(key) ?? 0) + 1);
    const dkey = JSON.stringify([method, route]);
    let s = this.durations.get(dkey);
    if (!s) this.durations.set(dkey, (s = { count: 0, sum: 0, buckets: BUCKETS.map(() => 0) }));
    s.count += 1;
    s.sum += seconds;
    BUCKETS.forEach((le, i) => {
      if (seconds <= le) s.buckets[i]! += 1;
    });
  }

  render(): string[] {
    const lines = [
      "# HELP hbe_http_requests_total HTTP requests answered, by route and status class.",
      "# TYPE hbe_http_requests_total counter",
    ];
    for (const [key, n] of this.requests) {
      const [method, route, status] = JSON.parse(key) as [string, string, string];
      lines.push(`hbe_http_requests_total${labels({ method, route, status })} ${n}`);
    }
    lines.push(
      "# HELP hbe_http_request_duration_seconds Time to answer HTTP requests, by route.",
      "# TYPE hbe_http_request_duration_seconds histogram",
    );
    for (const [key, s] of this.durations) {
      const [method, route] = JSON.parse(key) as [string, string];
      BUCKETS.forEach((le, i) =>
        lines.push(
          `hbe_http_request_duration_seconds_bucket${labels({ method, route, le: String(le) })} ${s.buckets[i]}`,
        ),
      );
      lines.push(`hbe_http_request_duration_seconds_bucket${labels({ method, route, le: "+Inf" })} ${s.count}`);
      lines.push(`hbe_http_request_duration_seconds_sum${labels({ method, route })} ${s.sum.toFixed(6)}`);
      lines.push(`hbe_http_request_duration_seconds_count${labels({ method, route })} ${s.count}`);
    }
    return lines;
  }
}

/** Background jobs this process ran, by queue (the worker records them). */
export class JobMetrics {
  private readonly jobs = new Map<string, { completed: number; failed: number; seconds: number }>();

  record(queue: string, ok: boolean, seconds: number): void {
    let j = this.jobs.get(queue);
    if (!j) this.jobs.set(queue, (j = { completed: 0, failed: 0, seconds: 0 }));
    if (ok) j.completed += 1;
    else j.failed += 1;
    j.seconds += seconds;
  }

  render(): string[] {
    const lines = [
      "# HELP hbe_jobs_total Background jobs this process ran, by queue and outcome.",
      "# TYPE hbe_jobs_total counter",
    ];
    for (const [queue, j] of this.jobs) {
      lines.push(`hbe_jobs_total${labels({ queue, outcome: "completed" })} ${j.completed}`);
      lines.push(`hbe_jobs_total${labels({ queue, outcome: "failed" })} ${j.failed}`);
    }
    lines.push(
      "# HELP hbe_job_duration_seconds_total Time spent running background jobs, by queue.",
      "# TYPE hbe_job_duration_seconds_total counter",
    );
    for (const [queue, j] of this.jobs) {
      lines.push(`hbe_job_duration_seconds_total${labels({ queue })} ${j.seconds.toFixed(3)}`);
    }
    return lines;
  }
}

/** One per process: the worker records into it, /metrics reports it. */
export const jobMetrics = new JobMetrics();

const escapeLabel = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
const labels = (l: Record<string, string>) =>
  `{${Object.entries(l)
    .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
    .join(",")}}`;

function gauge(lines: string[], name: string, help: string, values: [Record<string, string>, number][]): void {
  lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
  for (const [l, v] of values) lines.push(`${name}${Object.keys(l).length ? labels(l) : ""} ${v}`);
}

/**
 * GET /metrics in the Prometheus text format, for a scraper holding METRICS_TOKEN: HTTP traffic
 * of this process, and (with a database) the platform's queues, runs and webhook backlog.
 */
export function metricsRoutes(app: FastifyInstance, settings: Settings, db: Db | null): void {
  const token = settings.env.METRICS_TOKEN;
  const http = new HttpMetrics();
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  app.addHook("onClose", async () => loop.disable());

  app.addHook("onResponse", async (req, reply) => {
    const route = req.routeOptions.url;
    if (route === "/metrics") return;
    http.record(req.method, route ?? "unmatched", reply.statusCode, reply.elapsedTime / 1000);
  });

  if (!token) return;
  const expected = Buffer.from(`Bearer ${token}`);
  app.get("/metrics", { logLevel: "warn" }, async (req, reply) => {
    const given = Buffer.from(req.headers.authorization ?? "");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return reply.code(401).send({ error: "unauthorized", message: "A metrics token is needed." });
    }
    const lines = [...http.render(), ...jobMetrics.render()];
    const mem = process.memoryUsage();
    gauge(lines, "hbe_process_resident_memory_bytes", "Resident memory of this process.", [[{}, mem.rss]]);
    gauge(lines, "hbe_process_uptime_seconds", "Seconds since this process started.", [
      [{}, Math.round(process.uptime())],
    ]);
    gauge(lines, "hbe_event_loop_delay_p99_seconds", "99th percentile event loop delay.", [
      [{}, loop.percentile(99) / 1e9],
    ]);
    loop.reset();

    if (db) {
      const h = await platformHealth(db, settings);
      gauge(
        lines,
        "hbe_queue_jobs",
        "Background jobs by queue and state (failed: last 24 hours).",
        h.queues.flatMap((q) =>
          (["queued", "active", "retrying", "failed"] as const).map(
            (state) => [{ queue: q.name, state }, q[state]] as [Record<string, string>, number],
          ),
        ),
      );
      gauge(lines, "hbe_webhooks_unprocessed", "GitHub webhook deliveries stored but not processed yet.", [
        [{}, h.webhooks.unprocessed],
      ]);
      gauge(lines, "hbe_webhooks_oldest_unprocessed_seconds", "Age of the oldest unprocessed webhook delivery.", [
        [{}, h.webhooks.oldestUnprocessedAt ? (Date.now() - Date.parse(h.webhooks.oldestUnprocessedAt)) / 1000 : 0],
      ]);
      gauge(lines, "hbe_runs", "Test runs waiting for or using a runner.", [
        [{ state: "queued" }, h.runs.queued],
        [{ state: "active" }, h.runs.active],
      ]);
      gauge(lines, "hbe_runs_concurrency_limit", "How many runs may use runners at once.", [[{}, h.runs.concurrency]]);
      gauge(lines, "hbe_runner_minutes_used", "Runner minutes used this month.", [[{}, h.runnerMinutes.used]]);
      gauge(lines, "hbe_runner_minutes_budget", "Runner minutes budgeted for the month.", [
        [{}, h.runnerMinutes.budget],
      ]);
    }
    return reply
      .header("content-type", "text/plain; version=0.0.4; charset=utf-8")
      .header("cache-control", "no-store")
      .send(lines.join("\n") + "\n");
  });
}
