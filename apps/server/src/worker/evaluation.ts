import { checkRunSummary, scoreRun, type RunResults, type StageResult } from "@hbe/core";
import { sql, type Db, type Json } from "@hbe/db";
import { GitHubError, type GitHubClient } from "@hbe/github";
import type { JobQueue } from "@hbe/queue";
import type { Settings } from "@hbe/settings";
import { randomBytes } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { hashToken, queueRun } from "../evaluation.ts";

export interface EvaluationDeps {
  db: Db;
  queue: JobQueue;
  github: GitHubClient;
  settings: Settings;
  log: FastifyBaseLogger;
}

/**
 * Starts the grader workflow for a queued run: the grader checks out the student's commit,
 * runs the stack profile's stages and the hidden suite, and calls back with results.
 */
export async function dispatchRun(
  deps: EvaluationDeps,
  runId: string,
): Promise<"dispatched" | "deferred" | "cancelled" | "skipped" | "failed"> {
  const { db, github, settings, queue, log } = deps;
  const limits = settings.profile.evaluation;
  const run = await db
    .selectFrom("evaluation_runs as e")
    .innerJoin("submissions as s", "s.id", "e.submission_id")
    .innerJoin("repositories as r", "r.id", "s.repository_id")
    .leftJoin("grader_suites as g", "g.id", "e.grader_suite_id")
    .leftJoin("stack_profiles as p", "p.id", "e.stack_profile_id")
    .select([
      "e.id",
      "e.institution_id",
      "e.status",
      "e.trigger",
      "e.sha",
      "r.owner",
      "r.name",
      "g.path as suite_path",
      "g.git_ref as suite_ref",
      "p.key as profile_key",
      "p.version as profile_version",
      "p.definition",
    ])
    .where("e.id", "=", runId)
    .executeTakeFirst();
  if (!run || run.status !== "queued") return "skipped";
  if (!run.suite_path) {
    await finishWithError(db, runId, "infra_error", "The assignment has no grader suite.");
    return "failed";
  }

  // The platform pays for runner minutes: once the monthly budget is spent, automatic runs
  // stop; runs someone asked for (and deadline runs) still go.
  if (run.trigger === "push" || run.trigger === "pull_request") {
    if ((await runnerMinutesThisMonth(db)) >= limits.monthly_runner_minutes_budget) {
      await finishWithError(
        db,
        runId,
        "cancelled",
        "Automatic test runs are paused for the rest of the month (the evaluation budget is used up). You can still start a run yourself.",
      );
      log.warn({ runId }, "monthly runner budget reached: automatic run cancelled");
      return "cancelled";
    }
  }

  const [graderOwner, graderRepo] = (settings.env.GRADER_REPO ?? "").split("/");
  if (!graderOwner || !graderRepo) throw new Error("GRADER_REPO is not configured");
  const token = settings.env.GRADER_CALLBACK_AUTH === "token" ? randomBytes(24).toString("base64url") : null;

  // Claim the run under a lock, within the concurrency caps (platform-wide, and per
  // institution so one tenant's deadline rush can't starve the others).
  const claim = await db.transaction().execute(async (tx) => {
    await sql`select pg_advisory_xact_lock(hashtext('hbe:dispatch-run'))`.execute(tx);
    const { rows } = await sql<{ global: number; institution: number }>`
      select count(*)::int as global, (count(*) filter (where institution_id = ${run.institution_id}))::int as institution
      from evaluation_runs where status in ('dispatched', 'running')`.execute(tx);
    const load = rows[0] ?? { global: 0, institution: 0 };
    if (load.global >= limits.global_concurrency || load.institution >= limits.institution_concurrency) return "busy";
    const claimed = await tx
      .updateTable("evaluation_runs")
      .set({ status: "dispatched", dispatched_at: new Date(), callback_token_hash: token ? hashToken(token) : null })
      .where("id", "=", runId)
      .where("status", "=", "queued")
      .executeTakeFirst();
    return claimed.numUpdatedRows > 0n ? "claimed" : "gone";
  });
  if (claim === "gone") return "skipped";
  if (claim === "busy") {
    await queue.send("dispatch-run", { runId }, { startAfterSeconds: 30, singletonKey: `dispatch-${runId}` });
    return "deferred";
  }

  try {
    const installationId = await github.installationIdForRepo(graderOwner, graderRepo);
    await github
      .forInstallation(installationId)
      .dispatchWorkflow(graderOwner, graderRepo, settings.env.GRADER_WORKFLOW, settings.env.GRADER_REF, {
        run_id: run.id,
        repo_owner: run.owner,
        repo_name: run.name,
        sha: run.sha,
        suite_path: run.suite_path,
        suite_ref: run.suite_ref ?? settings.env.GRADER_REF,
        stack_profile: JSON.stringify({
          key: run.profile_key,
          version: run.profile_version,
          ...(run.definition as object),
        }),
        api_url: settings.env.API_URL,
        job_timeout_minutes: String(limits.job_timeout_minutes),
        ...(token ? { callback_token: token } : {}),
      });
  } catch (err) {
    if (err instanceof GitHubError && !err.retryable) {
      await finishWithError(db, runId, "infra_error", `Could not start the grader: ${err.message}`);
      log.error({ runId, err: err.message }, "grader dispatch failed");
      return "failed";
    }
    // Release the claim; the job is retried.
    await db
      .updateTable("evaluation_runs")
      .set({ status: "queued", dispatched_at: null, callback_token_hash: null })
      .where("id", "=", runId)
      .where("status", "=", "dispatched")
      .execute();
    throw err;
  }
  log.info({ runId }, "grader dispatched");
  if (settings.env.GITHUB_FAKE && token) {
    // Local development: nothing runs the in-memory GitHub's workflows, so say how to grade it.
    const profile = JSON.stringify({
      key: run.profile_key,
      version: run.profile_version,
      ...(run.definition as object),
    });
    log.info(
      `To grade run ${run.id}, run the harness against a checkout of the student's code:\n` +
        `node grader/harness/run.mjs --run-id ${run.id} --sha ${run.sha} --submission <student-code-dir> ` +
        `--suite grader/${run.suite_path} --profile '${profile}' --api-url ${settings.env.API_URL} --token ${token}`,
    );
  }
  return "dispatched";
}

async function finishWithError(db: Db, runId: string, status: "infra_error" | "cancelled", error: string) {
  await db
    .updateTable("evaluation_runs")
    .set({ status, error: error.slice(0, 1000), finished_at: new Date() })
    .where("id", "=", runId)
    .execute();
}

/** Approximate Actions minutes used this calendar month (UTC): run time rounded up, plus setup. */
export async function runnerMinutesThisMonth(db: Db): Promise<number> {
  const { rows } = await sql<{ minutes: number }>`
    select coalesce(sum(ceil(extract(epoch from coalesce(finished_at, now()) - started_at) / 60) + 1), 0)::int as minutes
    from evaluation_runs
    where started_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc'`.execute(db);
  return rows[0]?.minutes ?? 0;
}

/** Scores a finished run and posts the result to the student's commit as a check run. */
export async function scoreAndReport(deps: EvaluationDeps, runId: string): Promise<number | null> {
  const { db, github, settings, log } = deps;
  const run = await db
    .selectFrom("evaluation_runs as e")
    .innerJoin("submissions as s", "s.id", "e.submission_id")
    .innerJoin("assignments as a", "a.id", "s.assignment_id")
    .innerJoin("courses as c", "c.id", "a.course_id")
    .innerJoin("institutions as i", "i.id", "e.institution_id")
    .innerJoin("repositories as r", "r.id", "s.repository_id")
    .innerJoin("github_installations as g", "g.id", "r.github_installation_id")
    .select([
      "e.id",
      "e.status",
      "e.sha",
      "e.summary",
      "e.error",
      "e.check_run_id",
      "s.id as submission_id",
      "a.id as assignment_id",
      "c.id as course_id",
      "i.slug",
      "r.owner",
      "r.name",
      "g.installation_id",
    ])
    .where("e.id", "=", runId)
    .executeTakeFirst();
  if (!run || (run.status !== "completed" && run.status !== "infra_error")) return null;
  if (run.status === "infra_error") await retryGradedRun(deps, runId);

  const tests = await db.selectFrom("test_results").selectAll().where("run_id", "=", runId).execute();
  const stages = ((run.summary as { stages?: StageResult[] } | null)?.stages ?? []).map((stage) => ({
    ...stage,
    tests: tests
      .filter((t) => t.stage === stage.key)
      .map((t) => ({
        id: t.test_key,
        title: t.title,
        category: t.category ?? undefined,
        status: t.status,
        weight: Number(t.weight),
        expected: t.expected ?? undefined,
        actual: t.actual ?? undefined,
        hint: t.hint ?? undefined,
      })),
  }));
  const results: RunResults = {
    run_id: run.id,
    sha: run.sha,
    started_at: "",
    finished_at: "",
    infra_error: run.status === "infra_error" ? (run.error ?? "infra error") : null,
    stages,
  };
  const score = scoreRun(results);

  await db
    .updateTable("evaluation_runs")
    .set({
      score: score.score === null ? null : String(score.score),
      summary: JSON.stringify({ stages: (run.summary as { stages?: unknown[] })?.stages ?? [], ...score }) as Json,
    })
    .where("id", "=", runId)
    .execute();

  if (!run.check_run_id) {
    const url = new URL(
      `/i/${run.slug}/courses/${run.course_id}/assignments/${run.assignment_id}/submissions/${run.submission_id}/runs/${run.id}`,
      settings.env.APP_URL,
    ).toString();
    const { title, summary } = checkRunSummary(results, score, url);
    try {
      const checkRunId = await github.forInstallation(run.installation_id).createCheckRun(run.owner, run.name, {
        name: "HBE tests",
        headSha: run.sha,
        conclusion: results.infra_error ? "neutral" : score.failed === 0 && !score.blockedBy ? "success" : "failure",
        title,
        summary,
        detailsUrl: url,
      });
      await db.updateTable("evaluation_runs").set({ check_run_id: checkRunId }).where("id", "=", runId).execute();
    } catch (err) {
      // The score is what matters; a missing check run is logged, not retried forever.
      if (err instanceof GitHubError && err.retryable) throw err;
      log.warn({ runId, err: err instanceof Error ? err.message : String(err) }, "could not post check run");
    }
  }
  return score.score;
}

const GRADED_RUN_ATTEMPTS = 3;

/** A graded run (deadline or re-grade) that hit a platform error is tried again, a few times. */
export async function retryGradedRun(
  deps: Pick<EvaluationDeps, "db" | "queue" | "settings" | "log">,
  runId: string,
): Promise<boolean> {
  const { db, log } = deps;
  const run = await db
    .selectFrom("evaluation_runs")
    .select(["submission_id", "sha", "trigger", "requested_by"])
    .where("id", "=", runId)
    .executeTakeFirst();
  if (!run || (run.trigger !== "deadline" && run.trigger !== "regrade")) return false;
  // Already retried (this can be called again when a job is retried).
  const newer = await db
    .selectFrom("evaluation_runs")
    .select("id")
    .where("submission_id", "=", run.submission_id)
    .where("sha", "=", run.sha)
    .where("trigger", "=", run.trigger)
    // Compared in SQL: JavaScript dates would drop the microseconds.
    .where("queued_at", ">", (eb) => eb.selectFrom("evaluation_runs").select("queued_at").where("id", "=", runId))
    .executeTakeFirst();
  if (newer) return false;
  const { n } = await db
    .selectFrom("evaluation_runs")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where("submission_id", "=", run.submission_id)
    .where("sha", "=", run.sha)
    .where("trigger", "=", run.trigger)
    .where("status", "=", "infra_error")
    .executeTakeFirstOrThrow();
  if (Number(n) >= GRADED_RUN_ATTEMPTS) {
    log.error({ runId, submissionId: run.submission_id }, "graded run keeps failing for platform reasons");
    return false;
  }
  await queueRun(deps, {
    submissionId: run.submission_id,
    sha: run.sha,
    trigger: run.trigger,
    requestedBy: run.requested_by,
  });
  return true;
}

/**
 * Keeps runs moving: runs whose grader never started or never finished become infra errors
 * (never graded); queued runs whose dispatch job was lost are queued again, and runs that
 * could not start for a day are given up.
 */
export async function reapRuns(deps: Pick<EvaluationDeps, "db" | "queue" | "settings" | "log">): Promise<number> {
  const { db, queue, log } = deps;
  const timeout = deps.settings.profile.evaluation.job_timeout_minutes + 15;
  const { rows } = await sql<{ id: string }>`
    update evaluation_runs set status = 'infra_error', finished_at = now(),
      error = case when status = 'dispatched' then 'The grader did not start within 30 minutes.'
                   when status = 'running' then 'The grader did not report results in time.'
                   else 'The grader could not be started.' end
    where (status = 'dispatched' and dispatched_at < now() - interval '30 minutes')
       or (status = 'running' and started_at < now() - make_interval(mins => ${timeout}))
       or (status = 'queued' and queued_at < now() - interval '24 hours')
    returning id`.execute(db);
  if (rows.length) log.warn({ count: rows.length }, "reaped stuck evaluation runs");
  for (const { id } of rows) await retryGradedRun(deps, id);

  // Deduplicated per run, so a run whose dispatch job is still pending is not queued twice.
  const stale = await db
    .selectFrom("evaluation_runs")
    .select("id")
    .where("status", "=", "queued")
    .where("queued_at", "<", sql<Date>`now() - interval '15 minutes'`)
    .orderBy("queued_at")
    .limit(100)
    .execute();
  for (const { id } of stale) await queue.send("dispatch-run", { runId: id }, { singletonKey: `dispatch-${id}` });
  return rows.length;
}
