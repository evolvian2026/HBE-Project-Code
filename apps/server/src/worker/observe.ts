import type { JobQueue } from "@hbe/queue";
import type { FastifyBaseLogger } from "fastify";
import type { ErrorReporter } from "../error-reports.ts";
import { jobMetrics } from "../metrics.ts";

/**
 * The queue, with every job handler timed, counted for /metrics, and its failures logged and
 * reported (then rethrown, so pg-boss retries the job as configured).
 */
export function observedQueue(queue: JobQueue, log: FastifyBaseLogger, errors: ErrorReporter): JobQueue {
  return {
    start: () => queue.start(),
    stop: () => queue.stop(),
    send: (name, data, options) => queue.send(name, data, options),
    schedule: (name, cron, data) => queue.schedule(name, cron, data),
    work: (name, handler, options) =>
      queue.work(
        name,
        async (job) => {
          const started = performance.now();
          try {
            await handler(job);
            jobMetrics.record(name, true, (performance.now() - started) / 1000);
          } catch (err) {
            const seconds = (performance.now() - started) / 1000;
            jobMetrics.record(name, false, seconds);
            log.error({ err, job: name, job_id: job.id, seconds }, "job failed");
            errors.capture(err, { job: name, job_id: job.id });
            throw err;
          }
        },
        options,
      ),
  };
}
