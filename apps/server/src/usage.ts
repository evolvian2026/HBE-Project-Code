import { effectiveLimits, institutionLimits } from "@hbe/core";
import { sql, type Db } from "@hbe/db";
import type { Settings } from "@hbe/settings";
import { runnerMinutesThisMonth } from "./worker/evaluation.ts";

/** The calendar month usage is counted in (UTC, as GitHub bills Actions minutes). */
const MONTH_START = sql`date_trunc('month', now() at time zone 'utc') at time zone 'utc'`;

/** Bytes an institution keeps in storage: run files, source snapshots and record exports. */
async function storageBytes(db: Db, institutionId?: string) {
  const where = institutionId ? sql`where institution_id = ${institutionId}` : sql``;
  const { rows } = await sql<{ artifacts: string; snapshots: string; exports: string }>`
    select
      (select coalesce(sum(size), 0) from run_artifacts ${where}) as artifacts,
      (select coalesce(sum(bundle_size + tarball_size), 0) from submission_snapshots ${where}) as snapshots,
      (select coalesce(sum(size), 0) from record_exports ${where}) as exports`.execute(db);
  const r = rows[0]!;
  return { artifacts: Number(r.artifacts), snapshots: Number(r.snapshots), exports: Number(r.exports) };
}

/** What an institution used this month, against its limits (for its admins). */
export async function institutionUsage(db: Db, settings: Settings, institutionId: string) {
  const inst = await db
    .selectFrom("institutions")
    .select(["limits"])
    .where("id", "=", institutionId)
    .executeTakeFirstOrThrow();
  const limits = effectiveLimits(settings.profile.evaluation, institutionLimits(inst.limits));
  const [minutes, runs, people, storage, reports, emails] = await Promise.all([
    runnerMinutesThisMonth(db, institutionId),
    sql<{ trigger: string; n: number }>`
      select trigger, count(*)::int as n from evaluation_runs
      where institution_id = ${institutionId} and queued_at >= ${MONTH_START} group by trigger`.execute(db),
    sql<{ active: number; invited: number; staff: number }>`
      select
        (select count(*)::int from institution_memberships
          where institution_id = ${institutionId} and role = 'student' and status = 'active') as active,
        (select count(*)::int from invitations
          where institution_id = ${institutionId} and role = 'student' and accepted_at is null and expires_at > now()) as invited,
        (select count(*)::int from institution_memberships
          where institution_id = ${institutionId} and role <> 'student' and status = 'active') as staff`.execute(db),
    storageBytes(db, institutionId),
    sql<{ n: number }>`select count(*)::int as n from grade_reports where institution_id = ${institutionId}`.execute(
      db,
    ),
    sql<{ sent: number; failed: number }>`
      select count(*) filter (where status = 'sent')::int as sent, count(*) filter (where status = 'failed')::int as failed
      from email_outbox where institution_id = ${institutionId} and created_at >= ${MONTH_START}`.execute(db),
  ]);
  return {
    month: new Date().toISOString().slice(0, 7),
    runnerMinutes: { used: minutes, allowance: limits.monthlyRunnerMinutes },
    runs: Object.fromEntries(runs.rows.map((r) => [r.trigger, r.n])) as Record<string, number>,
    concurrency: limits.concurrency,
    students: { active: people.rows[0]!.active, invited: people.rows[0]!.invited, limit: limits.maxActiveStudents },
    staff: people.rows[0]!.staff,
    storageBytes: storage,
    gradeReports: reports.rows[0]!.n,
    emails: emails.rows[0]!,
  };
}

/** The platform's health (super admins): queues, failures, webhook backlog, runs and usage. */
export async function platformHealth(db: Db, settings: Settings) {
  // The job tables exist once a worker has started (pg-boss creates them).
  const { rows: boss } = await sql<{ ok: boolean }>`select to_regclass('pgboss.job') is not null as ok`.execute(db);
  const none = { rows: [] as never[] };
  const [queues, failures, webhooks, runs, minutes, institutions] = await Promise.all([
    !boss[0]?.ok
      ? none
      : sql<{ name: string; queued: number; active: number; retrying: number; failed: number }>`
      select name,
        count(*) filter (where state = 'created')::int as queued,
        count(*) filter (where state = 'active')::int as active,
        count(*) filter (where state = 'retry')::int as retrying,
        count(*) filter (where state = 'failed' and completed_on > now() - interval '24 hours')::int as failed
      from pgboss.job
      where state in ('created', 'active', 'retry') or (state = 'failed' and completed_on > now() - interval '24 hours')
      group by name order by name`.execute(db),
    !boss[0]?.ok
      ? none
      : sql<{ name: string; at: Date; error: string | null }>`
      select name, completed_on as at, left(coalesce(output ->> 'message', output::text), 500) as error
      from pgboss.job where state = 'failed' and completed_on > now() - interval '24 hours'
      order by completed_on desc limit 10`.execute(db),
    sql<{ unprocessed: number; oldest: Date | null; errored: number }>`
      select count(*) filter (where processed_at is null)::int as unprocessed,
             min(received_at) filter (where processed_at is null) as oldest,
             count(*) filter (where error is not null and processed_at is null)::int as errored
      from github_events where received_at > now() - interval '7 days'`.execute(db),
    sql<{ queued: number; active: number }>`
      select count(*) filter (where status = 'queued')::int as queued,
             count(*) filter (where status in ('dispatched', 'running'))::int as active
      from evaluation_runs where status in ('queued', 'dispatched', 'running')`.execute(db),
    runnerMinutesThisMonth(db),
    sql<{ id: string; name: string; slug: string; status: string; students: number; minutes: number; runs: number }>`
      select i.id, i.name, i.slug, i.status,
        (select count(*)::int from institution_memberships m
          where m.institution_id = i.id and m.role = 'student' and m.status = 'active') as students,
        (select coalesce(sum(ceil(extract(epoch from coalesce(e.finished_at, now()) - e.started_at) / 60) + 1), 0)::int
          from evaluation_runs e where e.institution_id = i.id and e.started_at >= ${MONTH_START}) as minutes,
        (select count(*)::int from evaluation_runs e where e.institution_id = i.id and e.queued_at >= ${MONTH_START}) as runs
      from institutions i where i.status <> 'purged' order by i.name`.execute(db),
  ]);
  const plan = settings.profile;
  const hook = webhooks.rows[0]!;
  return {
    queues: queues.rows,
    recentFailures: failures.rows.map((f) => ({ ...f, at: new Date(f.at).toISOString() })),
    webhooks: {
      unprocessed: hook.unprocessed,
      oldestUnprocessedAt: hook.oldest ? new Date(hook.oldest).toISOString() : null,
      errored: hook.errored,
    },
    runs: { ...runs.rows[0]!, concurrency: plan.evaluation.global_concurrency },
    runnerMinutes: { used: minutes, budget: plan.evaluation.monthly_runner_minutes_budget },
    storageBytes: await storageBytes(db),
    institutions: institutions.rows,
  };
}
