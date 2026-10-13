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
import { syncTeamAccess } from "../teams.ts";
import { sweepExpiredArtifacts } from "./artifacts.ts";
import { postFeedback, sweepFeedback } from "./feedback.ts";
import { queueReconciliation, reconcileRepository, redeliverFailed } from "./reconcile.ts";
import { finalizeDueSubmissions } from "./deadlines.ts";
import { dispatchRun, reapRuns, scoreAndReport } from "./evaluation.ts";
import { noErrorReports, type ErrorReporter } from "../error-reports.ts";
import { observedQueue } from "./observe.ts";
import { sweepRetention } from "./retention.ts";
import { erasePerson } from "../erasure.ts";

/** Registers job handlers and schedules. Runs only in processes with the worker role. */
export async function startWorker(
  deps: WorkerDeps & { github: GitHubClient; store: ObjectStore; errors?: ErrorReporter },
  settings: Settings,
): Promise<void> {
  const { log } = deps;
  // Handlers send follow-up jobs with deps.queue; this one only registers them.
  const queue = observedQueue(deps.queue, log, deps.errors ?? noErrorReports);
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
  await queue.work("retention-sweep", async () => {
    const deleted = await sweepRetention(records);
    if (Object.values(deleted).some(Boolean)) log.info({ deleted }, "retention sweep");
  });
  await queue.schedule("retention-sweep", "37 3 * * *", {});
  await queue.work("erase-person", async (job) => {
    await erasePerson({ ...records, queue: deps.queue }, job.data.requestId);
  });

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

  // Team repositories' collaborators follow team membership.
  await queue.work("team-access", async (job) => {
    await syncTeamAccess({ db: deps.db, github: deps.github, log }, job.data.teamId);
  });

  // Released feedback goes to the repository's GitHub "Feedback" issue (assignments that opt in).
  await queue.work("post-feedback", async (job) => {
    await postFeedback({ db: deps.db, github: deps.github, settings, log }, job.data.repositoryId);
  });
  await queue.work("feedback-sweep", async () => {
    const n = await sweepFeedback(deps);
    if (n) log.info({ repositories: n }, "feedback to post to GitHub");
  });
  await queue.schedule("feedback-sweep", "*/10 * * * *", {});

  // Missed webhooks: failed deliveries are asked for again; active repositories' pushes are
  // checked against GitHub's event feed (and each one just before its cutoff).
  await queue.work("github-redeliver", async () => {
    await redeliverFailed(deps);
  });
  await queue.schedule("github-redeliver", "*/15 * * * *", {});
  await queue.work("github-reconcile", async () => {
    const n = await queueReconciliation(deps);
    log.info({ repositories: n }, "reconciling repositories with GitHub");
  });
  await queue.schedule("github-reconcile", "37 */3 * * *", {});
  await queue.work("reconcile-repo", async (job) => {
    await reconcileRepository(deps, job.data.repositoryId);
  });
  log.info({ concurrency: settings.profile.runtime.queue_concurrency }, "worker started");
}
