/**
 * Load test at the NFR-1 / NFR-2 targets (docs/LOAD_TEST.md): about 100 students active at
 * once, a burst of pushes, and a deadline rush of test-run requests, against a running stack.
 *
 *   pnpm --filter @hbe/e2e load            (reads ../.env.local; see LOAD_TEST.md for options)
 *
 * It creates its own institution, course, assignment and students (real Supabase Auth users
 * with real sessions), and deletes them afterwards. Never point it at production.
 */
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServerClient } from "@supabase/ssr";
import pg from "pg";

const env = (name: string, fallback?: string) => {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`${name} is not set`);
  return v;
};
const BASE = env("LOAD_BASE_URL", "http://localhost:3000");
const API = env("LOAD_API_URL", BASE);
const SUPABASE_URL = env("SUPABASE_URL");
const PUBLISHABLE = env("SUPABASE_PUBLISHABLE_KEY");
const SECRET = env("SUPABASE_SECRET_KEY");
const DATABASE_URL = env("LOAD_DATABASE_URL", "postgresql://postgres:postgres@127.0.0.1:54322/postgres");
const WEBHOOK_SECRET = env("LOAD_WEBHOOK_SECRET", process.env.GITHUB_WEBHOOK_SECRET ?? "local-secret");
const STUDENTS = Number(env("LOAD_STUDENTS", "100"));
const DURATION_S = Number(env("LOAD_DURATION_S", "60"));
/** Time a student spends on a page before the next, e.g. 1000-3000 (a stress pace). */
const THINK_MS = env("LOAD_THINK_MS", "5000-15000").split("-").map(Number) as [number, number];
const PUSHES = Number(env("LOAD_PUSHES", "200"));
const OUT = process.env.LOAD_OUT;

if (/supabase\.co|onrender\.com/.test(SUPABASE_URL + BASE) && process.env.LOAD_I_KNOW !== "yes") {
  throw new Error("This looks like a deployed stack. Set LOAD_I_KNOW=yes to load a staging environment.");
}

const db = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
const q = async <T>(text: string, values: unknown[] = []) => (await db.query(text, values)).rows as T[];
const suffix = Date.now().toString(36);
const slug = `load-${suffix}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------
// Measurements

const samples = new Map<string, { ms: number[]; errors: Map<string, number> }>();
function record(kind: string, ms: number, error?: string) {
  let s = samples.get(kind);
  if (!s) samples.set(kind, (s = { ms: [], errors: new Map() }));
  if (error) s.errors.set(error, (s.errors.get(error) ?? 0) + 1);
  else s.ms.push(ms);
}
async function timed(
  kind: string,
  fn: () => Promise<Response>,
  ok: (r: Response, body: string) => boolean = (r) => r.ok,
): Promise<Response | null> {
  const started = performance.now();
  try {
    const res = await fn();
    const body = await res.text(); // the whole response, as a browser would wait for
    const ms = performance.now() - started;
    record(kind, ms, ok(res, body) ? undefined : `HTTP ${res.status}`);
    return res;
  } catch (err) {
    record(kind, performance.now() - started, (err as Error).message.slice(0, 80));
    return null;
  }
}
const pct = (sorted: number[], p: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]! : NaN;
function summary() {
  return [...samples].map(([kind, s]) => {
    const sorted = [...s.ms].sort((a, b) => a - b);
    return {
      kind,
      requests: sorted.length + [...s.errors.values()].reduce((a, b) => a + b, 0),
      errors: Object.fromEntries(s.errors),
      p50: Math.round(pct(sorted, 50)),
      p95: Math.round(pct(sorted, 95)),
      p99: Math.round(pct(sorted, 99)),
      max: Math.round(sorted.at(-1) ?? NaN),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Setup: an institution with one course, one published assignment and STUDENTS students, each
// with a repository, commits, a finished test run and some notifications.

interface Student {
  id: string;
  email: string;
  submissionId: string;
  repoId: number;
  repoName: string;
  cookie: string;
  token: string;
}

async function createUser(email: string, password: string): Promise<string> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: { apikey: SECRET, authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!res.ok) throw new Error(`creating ${email}: HTTP ${res.status} ${await res.text()}`);
  return ((await res.json()) as { id: string }).id;
}

/** Signs in like the web app does, and returns the session cookies it would set. */
async function signIn(email: string, password: string): Promise<{ cookie: string; token: string }> {
  const jar = new Map<string, string>();
  const supabase = createServerClient(SUPABASE_URL, PUBLISHABLE, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (cookies) => cookies.forEach((c) => (c.value ? jar.set(c.name, c.value) : jar.delete(c.name))),
    },
  });
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error(`signing in ${email}: ${error?.message}`);
  return {
    cookie: [...jar].map(([n, v]) => `${n}=${v}`).join("; "),
    token: data.session.access_token,
  };
}

async function inBatches<T, R>(items: T[], size: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map((item, j) => fn(item, i + j)))));
  }
  return out;
}

async function setUp() {
  const [inst] = await q<{ id: string }>("insert into public.institutions (name, slug) values ($1, $2) returning id", [
    `Load U ${suffix}`,
    slug,
  ]);
  const owner = `org-${suffix}`;
  const [gh] = await q<{ id: string }>(
    "insert into public.github_installations (institution_id, installation_id, account_id, account_login, account_type) values ($1, $2, 1, $3, 'Organization') returning id",
    [inst!.id, Math.floor(Math.random() * 1e9), owner],
  );
  const [course] = await q<{ id: string }>(
    "insert into public.courses (institution_id, code, name, term, github_installation_id) values ($1, 'LOAD1', 'Load testing', '2026-T1', $2) returning id",
    [inst!.id, gh!.id],
  );
  const [assignment] = await q<{ id: string }>(
    `insert into public.assignments (institution_id, course_id, slug, title, spec_md, stack_profile_id, grader_suite_id, template_repo,
                                     due_at, status, published_at, triggers, run_quota_per_day)
     values ($1, $2, 'todo-api', 'Todo API', E'# Todo API\\n\\nBuild a REST API for todos.',
             (select id from public.stack_profiles where key = 'node22-api'),
             (select id from public.grader_suites where key = 'todo-api' and institution_id is null), 't/t',
             now() + interval '3 days', 'published', now() - interval '7 days',
             '{"on_push": true, "on_pull_request": true, "manual": true}', 20)
     returning id`,
    [inst!.id, course!.id],
  );

  const password = randomBytes(18).toString("base64url");
  const emails = Array.from({ length: STUDENTS }, (_, i) => `load-${i}-${suffix}@load.test`);
  console.log(`Creating ${STUDENTS} students…`);
  const ids = await inBatches(emails, 10, (e) => createUser(e, password));

  const students: Student[] = [];
  for (const [i, id] of ids.entries()) {
    await q(
      "insert into public.institution_memberships (institution_id, user_id, role, status) values ($1, $2, 'student', 'active')",
      [inst!.id, id],
    );
    const repoId = Math.floor(Math.random() * 1e9);
    const repoName = `todo-api-${i}`;
    const head = randomBytes(20).toString("hex");
    const [repo] = await q<{ id: string }>(
      "insert into public.repositories (institution_id, github_installation_id, owner, name, github_repo_id, head_sha) values ($1, $2, $3, $4, $5, $6) returning id",
      [inst!.id, gh!.id, owner, repoName, repoId, head],
    );
    const [sub] = await q<{ id: string }>(
      "insert into public.submissions (institution_id, assignment_id, user_id, repository_id, status) values ($1, $2, $3, $4, 'active') returning id",
      [inst!.id, assignment!.id, id, repo!.id],
    );
    // In the course only once the submission exists, so provisioning has nothing to create.
    await q(
      "insert into public.course_memberships (institution_id, course_id, user_id, role) values ($1, $2, $3, 'student')",
      [inst!.id, course!.id, id],
    );
    for (let c = 0; c < 5; c++) {
      await q(
        `insert into public.commits (institution_id, repository_id, sha, message, authored_at, author_login, author_profile_id,
                                     details_status, parent_count, effective_lines, attribution)
         values ($1, $2, $3, $4, now() - ($5 || ' days')::interval, $6, $7, 'done', 1, 30, 'github')`,
        [
          inst!.id,
          repo!.id,
          c === 0 ? head : randomBytes(20).toString("hex"),
          `Commit ${c}`,
          String(c),
          `student-${i}`,
          id,
        ],
      );
    }
    const [run] = await q<{ id: string }>(
      `insert into public.evaluation_runs (institution_id, submission_id, sha, trigger, status, score, summary, queued_at, started_at, finished_at)
       values ($1, $2, $3, 'push', 'completed', 75, '{"stages": [], "passed": 3, "total": 4, "score": 75}',
               now() - interval '1 day', now() - interval '1 day', now() - interval '1 day') returning id`,
      [inst!.id, sub!.id, head],
    );
    await q(
      `insert into public.test_results (institution_id, run_id, stage, test_key, title, status) values
         ($1, $2, 'api', 'todos.create', 'Creates a todo', 'passed'),
         ($1, $2, 'api', 'todos.validate', 'Rejects an empty title', 'failed')`,
      [inst!.id, run!.id],
    );
    students.push({ id, email: emails[i]!, submissionId: sub!.id, repoId, repoName, cookie: "", token: "" });
  }

  console.log("Signing them in…");
  await inBatches(students, 10, async (s) => Object.assign(s, await signIn(s.email, password)));
  return { institutionId: inst!.id, courseId: course!.id, assignmentId: assignment!.id, owner, students };
}

async function tearDown() {
  await q("delete from public.institutions where slug = $1", [slug]);
  await q("delete from public.github_installations where account_login = $1", [`org-${suffix}`]);
  await q("delete from auth.users where email like $1", [`%-${suffix}@load.test`]);
}

// ---------------------------------------------------------------------------------------------
// Scenarios

/** STUDENTS people browsing at once: a page, then the API, then THINK_MS to read it. */
async function browsing(ctx: Awaited<ReturnType<typeof setUp>>) {
  const course = `/i/${slug}/courses/${ctx.courseId}`;
  const assignment = `${course}/assignments/${ctx.assignmentId}`;
  const pages = (s: Student): [string, string][] => [
    [`/i/${slug}`, "page: home"],
    [course, "page: course"],
    [assignment, "page: assignment"],
    [`${assignment}/submissions/${s.submissionId}`, "page: submission"],
    [`/i/${slug}/grades`, "page: grades"],
  ];
  const until = Date.now() + DURATION_S * 1000;
  console.log(`Browsing: ${STUDENTS} students for ${DURATION_S} s…`);
  await Promise.all(
    ctx.students.map(async (s, i) => {
      await sleep((i / STUDENTS) * THINK_MS[1]); // don't all start in the same millisecond
      let n = i;
      while (Date.now() < until) {
        const [path, kind] = pages(s)[n++ % 5]!;
        // A signed-in page names the institution (a sign-in redirect or error page doesn't).
        await timed(
          kind,
          () => fetch(`${BASE}${path}`, { headers: { cookie: s.cookie }, redirect: "manual" }),
          (r, body) => r.status === 200 && body.includes(`Load U ${suffix}`),
        );
        await timed("api: GET /v1/me", () =>
          fetch(`${API}/v1/me`, { headers: { authorization: `Bearer ${s.token}` } }),
        );
        await sleep(THINK_MS[0] + Math.random() * (THINK_MS[1] - THINK_MS[0]));
      }
    }),
  );
}

/** PUSHES signed push webhooks, 20 at a time; then how long until each was processed. */
async function pushes(ctx: Awaited<ReturnType<typeof setUp>>) {
  console.log(`Webhooks: ${PUSHES} pushes…`);
  const deliveries: string[] = [];
  await inBatches(
    Array.from({ length: PUSHES }, (_, i) => ctx.students[i % ctx.students.length]!),
    20,
    async (s) => {
      const sha = randomBytes(20).toString("hex");
      const delivery = randomUUID();
      deliveries.push(delivery);
      const body = JSON.stringify({
        ref: "refs/heads/main",
        after: sha,
        repository: { id: s.repoId, full_name: `${ctx.owner}/${s.repoName}`, pushed_at: Math.floor(Date.now() / 1000) },
        sender: { id: 1, login: "student", type: "User" },
        commits: [{ id: sha, message: "Work in progress", timestamp: new Date().toISOString() }],
      });
      await timed(
        "webhook: acknowledge push",
        () =>
          fetch(`${API}/webhooks/github`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-github-event": "push",
              "x-github-delivery": delivery,
              "x-hub-signature-256": `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`,
            },
            body,
          }),
        (r) => r.status === 202,
      );
    },
  );
  const deadline = Date.now() + 120_000;
  let rows: { delivery_id: string; ms: number | null }[] = [];
  while (Date.now() < deadline) {
    rows = await q(
      `select delivery_id, extract(epoch from processed_at - received_at) * 1000 as ms
       from public.github_events where delivery_id = any($1)`,
      [deliveries],
    );
    if (rows.length === deliveries.length && rows.every((r) => r.ms !== null)) break;
    await sleep(1000);
  }
  for (const r of rows)
    record("webhook: stored → processed", Number(r.ms ?? NaN), r.ms === null ? "not processed" : undefined);
  for (let i = rows.length; i < deliveries.length; i++) record("webhook: stored → processed", NaN, "not stored");
}

/** Every student asks for a test run in the same second (the night before the deadline). */
async function deadlineRush(ctx: Awaited<ReturnType<typeof setUp>>) {
  console.log(`Deadline rush: ${STUDENTS} test-run requests at once…`);
  await Promise.all(
    ctx.students.map((s) =>
      timed(
        "api: POST run request",
        () =>
          fetch(`${API}/v1/submissions/${s.submissionId}/runs`, {
            method: "POST",
            headers: { authorization: `Bearer ${s.token}`, "content-type": "application/json" },
            body: "{}",
          }),
        (r) => r.status === 201 || r.status === 200,
      ),
    ),
  );
  await sleep(10_000);
  const [runs] = await q<{ queued: number; dispatched: number; total: number }>(
    `select count(*) filter (where r.status = 'queued')::int as queued,
            count(*) filter (where r.status in ('dispatched', 'running'))::int as dispatched,
            count(*)::int as total
     from public.evaluation_runs r join public.submissions s on s.id = r.submission_id
     where s.institution_id = $1 and r.trigger = 'manual'`,
    [ctx.institutionId],
  );
  return runs!;
}

// ---------------------------------------------------------------------------------------------

const started = new Date();
let runs: Awaited<ReturnType<typeof deadlineRush>> | undefined;
try {
  const ctx = await setUp();
  await browsing(ctx);
  await pushes(ctx);
  runs = await deadlineRush(ctx);
} finally {
  await tearDown().catch((err) => console.error("cleanup failed:", err));
  await db.end();
}

const result = {
  started: started.toISOString(),
  target: { base: BASE, api: API },
  students: STUDENTS,
  durationSeconds: DURATION_S,
  thinkMs: THINK_MS,
  results: summary(),
  deadlineRuns: runs,
};
console.table(
  result.results.map(({ errors, ...r }) => ({
    ...r,
    errors: Object.keys(errors).length ? JSON.stringify(errors) : "",
  })),
);
console.log("Deadline rush runs:", runs);
if (OUT) writeFileSync(OUT, JSON.stringify(result, null, 2));
