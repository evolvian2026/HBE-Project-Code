import PgBoss from "pg-boss";

/** Every queue and its payload. Adding a queue here makes send/work type-safe everywhere. */
export interface QueuePayloads {
  /** Normalise one stored webhook delivery (github_events.id). */
  "github-event": { eventId: number };
  /** Re-enqueue deliveries that were stored but never processed. */
  "github-events-sweep": Record<string, never>;
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
