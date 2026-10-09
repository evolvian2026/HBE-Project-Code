import PgBoss from "pg-boss";

/** Every queue and its payload. Adding a queue here makes send/work type-safe everywhere. */
export interface QueuePayloads {
  /** Normalise one stored webhook delivery (github_events.id). */
  "github-event": { eventId: number };
  /** Re-enqueue deliveries that were stored but never processed. */
  "github-events-sweep": Record<string, never>;
  /** Send pending rows of email_outbox. */
  "email-outbox": Record<string, never>;
  /** Create a student's repository from the assignment template and give them access. */
  "provision-submission": { submissionId: string };
  /** Re-enqueue submissions stuck in provisioning. */
  "provisioning-sweep": Record<string, never>;
  /** Fetch author and line counts for a repository's pending commits. */
  "commit-details": { repositoryId: string };
  /** Recompute a submission's process score from its activity. */
  "process-score": { submissionId: string };
  /** Start the grader workflow for a queued evaluation run. */
  "dispatch-run": { runId: string };
  /** Score a finished run and report it as a GitHub check run. */
  "score-run": { runId: string };
  /** Mark runs whose grader never started or never finished. */
  "run-reaper": Record<string, never>;
  /** Fix the graded commit of submissions whose cutoff has passed. */
  "deadline-sweep": Record<string, never>;
  /** Recompute a finalized submission's grade (a new version if anything changed). */
  "compute-grade": { submissionId: string };
  /** Write the grade report (JSON + PDF) of a released grade version. */
  "grade-report": { gradeId: string };
  /** Remind students whose deadline is within 24 hours. */
  "deadline-reminder": Record<string, never>;
  /** Delete run artifacts past their expiry. */
  "artifact-sweep": Record<string, never>;
}
export type QueueName = keyof QueuePayloads;

interface QueueDefinition {
  retryLimit: number;
  retryDelay: number;
  retryBackoff: boolean;
  expireInSeconds: number;
  policy?: "standard" | "short" | "singleton" | "stately";
}

export const QUEUES: Record<QueueName, QueueDefinition> = {
  "github-event": { retryLimit: 5, retryDelay: 10, retryBackoff: true, expireInSeconds: 300 },
  "github-events-sweep": { retryLimit: 0, retryDelay: 0, retryBackoff: false, expireInSeconds: 120, policy: "stately" },
  "email-outbox": { retryLimit: 0, retryDelay: 0, retryBackoff: false, expireInSeconds: 120, policy: "stately" },
  "provision-submission": { retryLimit: 5, retryDelay: 30, retryBackoff: true, expireInSeconds: 300 },
  "provisioning-sweep": { retryLimit: 0, retryDelay: 0, retryBackoff: false, expireInSeconds: 120, policy: "stately" },
  "commit-details": { retryLimit: 5, retryDelay: 30, retryBackoff: true, expireInSeconds: 300 },
  "process-score": { retryLimit: 3, retryDelay: 10, retryBackoff: true, expireInSeconds: 120, policy: "stately" },
  // Always sent with singletonKey `dispatch-<runId>`: stately allows one pending job per run.
  "dispatch-run": { retryLimit: 5, retryDelay: 30, retryBackoff: true, expireInSeconds: 120, policy: "stately" },
  "score-run": { retryLimit: 5, retryDelay: 15, retryBackoff: true, expireInSeconds: 120 },
  "run-reaper": { retryLimit: 0, retryDelay: 0, retryBackoff: false, expireInSeconds: 120, policy: "stately" },
  "deadline-sweep": { retryLimit: 0, retryDelay: 0, retryBackoff: false, expireInSeconds: 300, policy: "stately" },
  "compute-grade": { retryLimit: 3, retryDelay: 10, retryBackoff: true, expireInSeconds: 120, policy: "stately" },
  "grade-report": { retryLimit: 5, retryDelay: 30, retryBackoff: true, expireInSeconds: 300, policy: "stately" },
  "deadline-reminder": { retryLimit: 0, retryDelay: 0, retryBackoff: false, expireInSeconds: 600, policy: "stately" },
  "artifact-sweep": { retryLimit: 0, retryDelay: 0, retryBackoff: false, expireInSeconds: 900, policy: "stately" },
};

export interface Job<N extends QueueName> {
  id: string;
  name: N;
  data: QueuePayloads[N];
}

export interface SendOptions {
  /** Jobs with the same key are de-duplicated while one is queued. */
  singletonKey?: string;
  startAfterSeconds?: number;
}

export interface JobQueue {
  start(): Promise<void>;
  stop(): Promise<void>;
  send<N extends QueueName>(name: N, data: QueuePayloads[N], options?: SendOptions): Promise<string | null>;
  work<N extends QueueName>(
    name: N,
    handler: (job: Job<N>) => Promise<void>,
    options?: { concurrency?: number },
  ): Promise<void>;
  schedule<N extends QueueName>(name: N, cron: string, data: QueuePayloads[N]): Promise<void>;
}

export interface PgBossQueueOptions {
  connectionString: string;
  /** Max pool size for the queue's own connections (session pooler on Supabase). */
  max: number;
  schema?: string;
  timezone: string;
  /** Days to keep completed/failed jobs in the archive before deletion. */
  archiveDays: number;
  pollingIntervalSeconds?: number;
  /**
   * Worker processes run pg-boss maintenance and fire cron schedules. API-only
   * processes just enqueue, so they leave both off.
   */
  runsMaintenance: boolean;
  onError?: (error: Error) => void;
}

/** Postgres-backed queue and scheduler (pg-boss) — see ARCHITECTURE.md §2 for why not Redis. */
export class PgBossQueue implements JobQueue {
  private readonly boss: PgBoss;
  private readonly options: PgBossQueueOptions;

  constructor(options: PgBossQueueOptions) {
    this.options = options;
    this.boss = new PgBoss({
      connectionString: options.connectionString,
      max: options.max,
      schema: options.schema ?? "pgboss",
      application_name: "hbe-queue",
      archiveCompletedAfterSeconds: 3600,
      archiveFailedAfterSeconds: 3600,
      deleteAfterDays: options.archiveDays,
      supervise: options.runsMaintenance,
      schedule: options.runsMaintenance,
    });
    this.boss.on("error", (error: Error) => options.onError?.(error));
  }

  async start(): Promise<void> {
    await this.boss.start();
    for (const [name, def] of Object.entries(QUEUES)) {
      // createQueue is idempotent in pg-boss 10; updateQueue applies changed retry settings.
      // A queue's policy can't change after creation: use a new queue name instead.
      await this.boss.createQueue(name, { name, ...def });
      await this.boss.updateQueue(name, { name, ...def });
    }
  }

  async stop(): Promise<void> {
    await this.boss.stop({ graceful: true, timeout: 30_000 });
  }

  send<N extends QueueName>(name: N, data: QueuePayloads[N], options: SendOptions = {}): Promise<string | null> {
    return this.boss.send(name, data, {
      ...(options.singletonKey ? { singletonKey: options.singletonKey } : {}),
      ...(options.startAfterSeconds ? { startAfter: options.startAfterSeconds } : {}),
    });
  }

  async work<N extends QueueName>(
    name: N,
    handler: (job: Job<N>) => Promise<void>,
    { concurrency = 1 }: { concurrency?: number } = {},
  ): Promise<void> {
    const pollingIntervalSeconds = this.options.pollingIntervalSeconds ?? 2;
    for (let i = 0; i < concurrency; i++) {
      await this.boss.work<QueuePayloads[N]>(name, { batchSize: 1, pollingIntervalSeconds }, async (jobs) => {
        for (const job of jobs) await handler({ id: job.id, name, data: job.data });
      });
    }
  }

  async schedule<N extends QueueName>(name: N, cron: string, data: QueuePayloads[N]): Promise<void> {
    await this.boss.schedule(name, cron, data, { tz: this.options.timezone });
  }
}
