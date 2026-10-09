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
import { s3ArchiveStore } from "../archive.ts";
import { buildExport } from "../records/export.ts";
import { purgeDueInstitutions, sendPurgeNotices } from "../records/lifecycle.ts";
import { replicateRecords } from "../records/replication.ts";
import { queueRosterSyncs, reconcileGrades, syncGrade, syncRoster } from "../lti/grades.ts";
import { sweepExpiredArtifacts } from "./artifacts.ts";
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
  await queue.work("artifact-sweep", async () => {
    const deleted = await sweepExpiredArtifacts(deps);
    if (deleted) log.info({ deleted }, "expired run artifacts deleted");
  });
  await queue.schedule("artifact-sweep", "23 3 * * *", {});

  // The records lifecycle (docs/ARCHITECTURE.md §12.4-12.5).
  const records = { ...deps, archive: s3ArchiveStore(settings), settings };
  await queue.work("records-replication", async () => {
    await replicateRecords(records, { budgetMs: 25 * 60_000 });
  });
  await queue.schedule("records-replication", "17 2 * * *", {});
  await queue.work("records-export", async (job) => {
    await buildExport(records, job.data.exportId);
  });
  await queue.work("records-notices", async () => {
    await sendPurgeNotices(records);
  });
  await queue.schedule("records-notices", "41 1 * * *", {});
  await queue.work("records-purge", async () => {
    // Replicate first, so the purge removes every replica it knows of.
    await replicateRecords(records, { budgetMs: 25 * 60_000 });
    const purged = await purgeDueInstitutions(records);
    if (purged.length) log.warn({ purged }, "institutions purged");
  });
  await queue.schedule("records-purge", "53 4 * * *", {});

  // LMS gradebooks and rosters (LTI Advantage).
  const lms = { db: deps.db, settings, queue };
  await queue.work("lms-grade-sync", async (job) => {
    await syncGrade(lms, job.data.gradeId, { force: job.data.force });
  });
  await queue.work("lms-roster-sync", async (job) => {
    const summary = await syncRoster(lms, job.data.courseLinkId);
    if (summary) log.info({ courseLinkId: job.data.courseLinkId, ...summary }, "LMS roster synced");
  });
  await queue.work("lms-roster-sweep", async () => {
    await queueRosterSyncs(deps.db, queue);
  });
  await queue.schedule("lms-roster-sweep", "11 1 * * *", {});
  await queue.work("lms-reconcile", async () => {
    const summary = await reconcileGrades(lms);
    log.info(summary, "LMS gradebooks reconciled");
  });
  await queue.schedule("lms-reconcile", "29 3 * * *", {});
  log.info({ concurrency: settings.profile.runtime.queue_concurrency }, "worker started");
}
