import type { Settings } from "@hbe/settings";
import { createEmailSender } from "../email/sender.ts";
import { drainEmailOutbox } from "./email-outbox.ts";
import { processGithubEvent, sweepUnprocessedEvents, type WorkerDeps } from "./github-events.ts";

/** Registers job handlers and schedules. Runs only in processes with the worker role. */
export async function startWorker(deps: WorkerDeps, settings: Settings): Promise<void> {
  const { queue, log } = deps;
  await queue.work("github-event", (job) => processGithubEvent(deps, job.data.eventId), {
    concurrency: settings.profile.runtime.queue_concurrency,
  });
  await queue.work("github-events-sweep", async () => {
    await sweepUnprocessedEvents(deps);
  });
  await queue.schedule("github-events-sweep", "*/5 * * * *", {});

  const sender = createEmailSender(settings, log);
  await queue.work("email-outbox", async () => {
    await drainEmailOutbox({ db: deps.db, sender, appUrl: settings.env.APP_URL, log });
  });
  await queue.schedule("email-outbox", "* * * * *", {});
  log.info({ concurrency: settings.profile.runtime.queue_concurrency }, "worker started");
}
