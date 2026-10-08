import type { Settings } from "@hbe/settings";
import { createEmailSender } from "../email/sender.ts";
import { drainEmailOutbox } from "./email-outbox.ts";
import type { GitHubClient } from "@hbe/github";
import { processGithubEvent, sweepUnprocessedEvents, type WorkerDeps } from "./github-events.ts";
import { provisionSubmission, sweepProvisioning } from "./provisioning.ts";
import { computeSubmissionProcess, fetchCommitDetails } from "./activity.ts";
import { recomputeGrade } from "../grading.ts";
import { remindDeadlines } from "../notifications.ts";
import { generateGradeReport } from "../reports/index.ts";
import type { ObjectStore } from "../storage.ts";
import { finalizeDueSubmissions } from "./deadlines.ts";
import { dispatchRun, reapRuns, scoreAndReport } from "./evaluation.ts";

/** Registers job handlers and schedules. Runs only in processes with the worker role. */
export async function startWorker(
  deps: WorkerDeps & { github: GitHubClient; store: ObjectStore },
  settings: Settings,
): Promise<void> {
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

  await queue.work(
    "provision-submission",
    async (job) => {
      await provisionSubmission({ ...deps, github: deps.github }, job.data.submissionId);
    },
    { concurrency: settings.profile.runtime.queue_concurrency },
  );
  await queue.work("provisioning-sweep", async () => {
    await sweepProvisioning(deps);
  });
  await queue.schedule("provisioning-sweep", "*/2 * * * *", {});

  await queue.work("commit-details", async (job) => {
    await fetchCommitDetails(deps, job.data.repositoryId);
  });
  await queue.work(
    "process-score",
    async (job) => {
      await computeSubmissionProcess(deps, job.data.submissionId);
    },
    { concurrency: settings.profile.runtime.queue_concurrency },
  );

  await queue.work("dispatch-run", async (job) => {
    await dispatchRun(deps, job.data.runId);
  });
  await queue.work("score-run", async (job) => {
    await scoreAndReport(deps, job.data.runId);
  });
  await queue.work("run-reaper", async () => {
    await reapRuns(deps);
  });
  await queue.schedule("run-reaper", "*/5 * * * *", {});
  await queue.work("deadline-sweep", async () => {
    await finalizeDueSubmissions(deps);
  });
  await queue.schedule("deadline-sweep", "* * * * *", {});
  await queue.work("compute-grade", async (job) => {
    await recomputeGrade(deps.db, job.data.submissionId, { actorId: null, queue });
  });
  await queue.work("grade-report", async (job) => {
    await generateGradeReport(deps, job.data.gradeId);
  });
  await queue.work("deadline-reminder", async () => {
    await remindDeadlines(deps.db, new Date(), queue);
  });
  await queue.schedule("deadline-reminder", "7 * * * *", {});
  log.info({ concurrency: settings.profile.runtime.queue_concurrency }, "worker started");
}
