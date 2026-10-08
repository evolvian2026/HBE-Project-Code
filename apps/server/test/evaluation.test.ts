import { randomUUID } from "node:crypto";
import { sql } from "@hbe/db";
import { FakeGitHub, GitHubError } from "@hbe/github";
import type { Settings } from "@hbe/settings";
import Fastify, { type FastifyInstance } from "fastify";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { hashToken } from "../src/evaluation.ts";
import { oidcGraderAuth, tokenGraderAuth } from "../src/grader-auth.ts";
import { handlePullRequest, handlePush } from "../src/worker/activity.ts";
import { dispatchRun, reapRuns, runnerMinutesThisMonth, scoreAndReport } from "../src/worker/evaluation.ts";
import { FakeQueue, FakeVerifier, Fixtures, randomGithubId, testDb, testSettings, unique } from "./helpers.ts";

const db = testDb();
const fixtures = new Fixtures(db);
const verifier = new FakeVerifier();
const log = Fastify({ logger: false }).log;
const settings = testSettings({ GRADER_CALLBACK_AUTH: "token" });
const sha = () => randomUUID().replace(/-/g, "").padEnd(40, "0").slice(0, 40);
const as = (userId: string) => ({ authorization: `Bearer ${verifier.tokenFor(userId)}` });

/** Generous limits, so runs from other tests in this file don't hold this one back. */
function withLimits(overrides: Partial<Settings["profile"]["evaluation"]>): Settings {
  return {
    ...settings,
    profile: {
      ...settings.profile,
      evaluation: {
        ...settings.profile.evaluation,
        global_concurrency: 1000,
        institution_concurrency: 1000,
        monthly_runner_minutes_budget: 1_000_000,
        ...overrides,
      },
    },
  };
}
const roomy = withLimits({});

interface Scenario {
  institutionId: string;
  slug: string;
  courseId: string;
  assignmentId: string;
  student: string;
  instructor: string;
  otherStudent: string;
  repositoryId: string;
  githubRepoId: number;
  owner: string;
  name: string;
  submissionId: string;
}

/** A published assignment with a grader suite, and one student with an active repository. */
async function scenario(
  opts: { quota?: number; triggers?: Record<string, boolean>; suite?: boolean } = {},
): Promise<Scenario> {
  const student = await fixtures.user({ githubId: randomGithubId() });
  const instructor = await fixtures.user();
  const otherStudent = await fixtures.user();
  const inst = await fixtures.institution([
    { userId: student, role: "student" },
    { userId: instructor, role: "teacher" },
    { userId: otherStudent, role: "student" },
  ]);
  const installationId = randomGithubId();
  fixtures.installationIds.push(installationId);
  const owner = `org-${unique()}`;
  const gh = await db
    .insertInto("github_installations")
    .values({
      institution_id: inst.id,
      installation_id: installationId,
      account_id: 1,
      account_login: owner,
      account_type: "Organization",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const course = await db
    .insertInto("courses")
    .values({ institution_id: inst.id, code: "C1", name: "Course", term: "T", github_installation_id: gh.id })
    .returning("id")
    .executeTakeFirstOrThrow();
  await db
    .insertInto("course_memberships")
    .values([
      { institution_id: inst.id, course_id: course.id, user_id: student, role: "student" },
      { institution_id: inst.id, course_id: course.id, user_id: instructor, role: "instructor" },
      { institution_id: inst.id, course_id: course.id, user_id: otherStudent, role: "student" },
    ])
    .execute();
  const profile = await db
    .selectFrom("stack_profiles")
    .select("id")
    .where("key", "=", "mern-node20")
    .executeTakeFirstOrThrow();
  const suite = await db
    .selectFrom("grader_suites")
    .select("id")
    .where("key", "=", "todo-api")
    .where("institution_id", "is", null)
    .executeTakeFirstOrThrow();
  const assignment = await db
    .insertInto("assignments")
    .values({
      institution_id: inst.id,
      course_id: course.id,
      slug: "todo-api",
      title: "Todo",
      stack_profile_id: profile.id,
      template_repo: "t/t",
      due_at: new Date(Date.now() + 7 * 86_400_000),
      status: "published",
      published_at: new Date(),
      grader_suite_id: opts.suite === false ? null : suite.id,
      run_quota_per_day: opts.quota ?? 2,
      triggers: JSON.stringify(opts.triggers ?? { on_push: true, on_pull_request: true, manual: true }),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const name = `todo-api-${unique()}`;
  const githubRepoId = randomGithubId();
  const repo = await db
    .insertInto("repositories")
    .values({ institution_id: inst.id, github_installation_id: gh.id, owner, name, github_repo_id: githubRepoId })
    .returning("id")
    .executeTakeFirstOrThrow();
  const submission = await db
    .insertInto("submissions")
    .values({
      institution_id: inst.id,
      assignment_id: assignment.id,
      user_id: student,
      repository_id: repo.id,
      status: "active",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return {
    institutionId: inst.id,
    slug: inst.slug,
    courseId: course.id,
    assignmentId: assignment.id,
    student,
    instructor,
    otherStudent,
    repositoryId: repo.id,
    githubRepoId,
    owner,
    name,
    submissionId: submission.id,
  };
}

const pushEvent = (s: Scenario, after: string, opts: { ref?: string; pushedAt?: number } = {}) => ({
  ref: opts.ref ?? "refs/heads/main",
  after,
  repository: {
    id: s.githubRepoId,
    full_name: `${s.owner}/${s.name}`,
    pushed_at: opts.pushedAt ?? Math.floor(Date.now() / 1000),
  },
  commits: [{ id: after, message: "Work", timestamp: new Date().toISOString(), distinct: true }],
});

const runsOf = (submissionId: string) =>
  db.selectFrom("evaluation_runs").selectAll().where("submission_id", "=", submissionId).orderBy("queued_at").execute();

let app: FastifyInstance;
let queue: FakeQueue;

beforeAll(async () => {
  queue = new FakeQueue();
  app = await buildApp({ settings, db, queue, verifier, graderAuth: tokenGraderAuth() });
});

afterAll(async () => {
  await app.close();
  await fixtures.cleanup();
  await db.destroy();
});

describe("automatic runs", () => {
  it("tests the new head of the default branch, debouncing bursts of pushes", async () => {
    const s = await scenario();
    const q = new FakeQueue();
    const deps = { db, queue: q, settings, log };
    const first = sha();
    const second = sha();
    const now = Math.floor(Date.now() / 1000);

    await handlePush(deps, pushEvent(s, first, { pushedAt: now - 10 }));
    let runs = await runsOf(s.submissionId);
    expect(runs).toMatchObject([{ trigger: "push", status: "queued", sha: first, requested_by: null }]);
    const dispatch = q.sent.find((j) => j.name === "dispatch-run");
    expect(dispatch).toMatchObject({
      data: { runId: runs[0]!.id },
      options: { singletonKey: `dispatch-${runs[0]!.id}`, startAfterSeconds: 300 },
    });

    await handlePush(deps, pushEvent(s, second, { pushedAt: now }));
    runs = await runsOf(s.submissionId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.sha).toBe(second);
    expect(q.sent.filter((j) => j.name === "dispatch-run")).toHaveLength(1);

    // A late redelivery of an older push doesn't move the head back.
    await handlePush(deps, pushEvent(s, sha(), { pushedAt: now - 60 }));
    const repo = await db
      .selectFrom("repositories")
      .select("head_sha")
      .where("id", "=", s.repositoryId)
      .executeTakeFirstOrThrow();
    expect(repo.head_sha).toBe(second);
    expect((await runsOf(s.submissionId))[0]!.sha).toBe(second);

    // Other branches are not tested on push.
    await handlePush(deps, pushEvent(s, sha(), { ref: "refs/heads/feature" }));
    expect(await runsOf(s.submissionId)).toHaveLength(1);
  });

  it("tests pull request heads, and respects the assignment's triggers", async () => {
    const s = await scenario({ triggers: { on_push: false, on_pull_request: true, manual: true } });
    const deps = { db, queue: new FakeQueue(), settings, log };
    await handlePush(deps, pushEvent(s, sha()));
    expect(await runsOf(s.submissionId)).toHaveLength(0);

    const head = sha();
    await handlePullRequest(deps, {
      action: "opened",
      repository: { id: s.githubRepoId, full_name: `${s.owner}/${s.name}` },
      pull_request: {
        id: randomGithubId(),
        number: 1,
        title: "Add todos",
        body: "Closes #1",
        state: "open",
        created_at: new Date().toISOString(),
        user: { id: 1, login: "ada" },
        head: { sha: head },
      },
    });
    expect(await runsOf(s.submissionId)).toMatchObject([{ trigger: "pull_request", sha: head }]);
  });

  it("skips assignments without a grader suite", async () => {
    const s = await scenario({ suite: false });
    await handlePush({ db, queue: new FakeQueue(), settings, log }, pushEvent(s, sha()));
    expect(await runsOf(s.submissionId)).toHaveLength(0);
  });
});

describe("POST /v1/submissions/:id/runs", () => {
  const start = (s: Scenario, userId: string, body: Record<string, unknown> = {}) =>
    app.inject({ method: "POST", url: `/v1/submissions/${s.submissionId}/runs`, headers: as(userId), payload: body });

  it("lets the student test their latest push within a daily quota", async () => {
    const s = await scenario({ quota: 2 });
    let res = await start(s, s.student);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("no_commits");

    const head = sha();
    await handlePush({ db, queue: new FakeQueue(), settings, log }, pushEvent(s, head));
    res = await start(s, s.student, { sha: sha() }); // students can't pick another commit
    expect(res.statusCode).toBe(201);
    const run = await db
      .selectFrom("evaluation_runs")
      .selectAll()
      .where("id", "=", res.json().runId)
      .executeTakeFirstOrThrow();
    expect(run).toMatchObject({ trigger: "manual", sha: head, requested_by: s.student, status: "queued" });

    expect((await start(s, s.student)).statusCode).toBe(201);
    res = await start(s, s.student);
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe("quota_exceeded");

    // Course staff have no quota and may test any commit.
    const staffSha = sha();
    res = await start(s, s.instructor, { sha: staffSha });
    expect(res.statusCode).toBe(201);
    expect(
      (
        await db
          .selectFrom("evaluation_runs")
          .select("sha")
          .where("id", "=", res.json().runId)
          .executeTakeFirstOrThrow()
      ).sha,
    ).toBe(staffSha);
  });

  it("refuses other students, closed assignments and disabled manual runs", async () => {
    const s = await scenario({ triggers: { on_push: true, on_pull_request: true, manual: false } });
    await handlePush({ db, queue: new FakeQueue(), settings, log }, pushEvent(s, sha()));
    expect((await start(s, s.otherStudent)).statusCode).toBe(403);
    const res = await start(s, s.student);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("manual_runs_disabled");
    expect((await start(s, s.instructor)).statusCode).toBe(201);

    await db.updateTable("assignments").set({ status: "closed" }).where("id", "=", s.assignmentId).execute();
    expect((await start(s, s.instructor)).json().error).toBe("not_open");
  });
});

describe("dispatching", () => {
  async function queuedRun(s: Scenario, trigger: "manual" | "push" = "manual") {
    return db
      .insertInto("evaluation_runs")
      .values({
        institution_id: s.institutionId,
        submission_id: s.submissionId,
        sha: sha(),
        trigger,
        grader_suite_id: (
          await db
            .selectFrom("assignments")
            .select("grader_suite_id")
            .where("id", "=", s.assignmentId)
            .executeTakeFirst()
        )?.grader_suite_id,
        stack_profile_id: null,
        requested_by: null,
        callback_token_hash: null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
  }

  it("starts the grader workflow with the run's inputs and a callback token", async () => {
    const s = await scenario();
    const run = await queuedRun(s);
    const github = new FakeGitHub();
    expect(await dispatchRun({ db, queue: new FakeQueue(), github, settings: roomy, log }, run.id)).toBe("dispatched");

    expect(github.dispatches).toHaveLength(1);
    const d = github.dispatches[0]!;
    expect(d).toMatchObject({ owner: "hbe-test", repo: "hbe-grader", workflowFile: "evaluate.yml", ref: "main" });
    expect(d.inputs).toMatchObject({
      run_id: run.id,
      repo_owner: s.owner,
      repo_name: s.name,
      suite_path: "suites/sample/todo-api",
      api_url: "http://localhost:4000",
    });
    const stored = await db
      .selectFrom("evaluation_runs")
      .selectAll()
      .where("id", "=", run.id)
      .executeTakeFirstOrThrow();
    expect(stored.status).toBe("dispatched");
    expect(stored.callback_token_hash).toBe(hashToken(d.inputs.callback_token!));

    // Dispatching twice is harmless.
    expect(await dispatchRun({ db, queue: new FakeQueue(), github, settings: roomy, log }, run.id)).toBe("skipped");
    expect(github.dispatches).toHaveLength(1);
  });

  it("defers when the institution is at its concurrency cap", async () => {
    const s = await scenario();
    const busy = await queuedRun(s);
    const waiting = await queuedRun(s);
    const github = new FakeGitHub();
    const q = new FakeQueue();
    const limited = withLimits({ institution_concurrency: 1 });
    expect(await dispatchRun({ db, queue: q, github, settings: limited, log }, busy.id)).toBe("dispatched");
    expect(await dispatchRun({ db, queue: q, github, settings: limited, log }, waiting.id)).toBe("deferred");
    expect(q.sent).toEqual([
      {
        name: "dispatch-run",
        data: { runId: waiting.id },
        options: { startAfterSeconds: 30, singletonKey: `dispatch-${waiting.id}` },
      },
    ]);
  });

  it("releases the claim on a transient GitHub error, and gives up on a permanent one", async () => {
    const s = await scenario();
    const run = await queuedRun(s);
    const github = new FakeGitHub();
    const deps = { db, queue: new FakeQueue(), github, settings: roomy, log };
    github.failures.push(new GitHubError(502, "Bad gateway", true));
    await expect(dispatchRun(deps, run.id)).rejects.toThrow("Bad gateway");
    const status = async () =>
      await db
        .selectFrom("evaluation_runs")
        .select(["status", "error"])
        .where("id", "=", run.id)
        .executeTakeFirstOrThrow();
    expect((await status()).status).toBe("queued");

    github.failures.push(new GitHubError(404, "Workflow not found", false));
    expect(await dispatchRun(deps, run.id)).toBe("failed");
    expect(await status()).toMatchObject({
      status: "infra_error",
      error: "Could not start the grader: Workflow not found",
    });
  });

  it("cancels automatic runs once the monthly budget is spent", async () => {
    const s = await scenario();
    const auto = await queuedRun(s, "push");
    const manual = await queuedRun(s, "manual");
    const used = await runnerMinutesThisMonth(db);
    const spent = withLimits({ monthly_runner_minutes_budget: Math.max(1, used) });
    // Make sure at least one minute is on the books.
    if (used === 0) {
      const other = await queuedRun(s);
      await db
        .updateTable("evaluation_runs")
        .set({ status: "completed", started_at: new Date(Date.now() - 60_000), finished_at: new Date() })
        .where("id", "=", other.id)
        .execute();
    }
    const deps = { db, queue: new FakeQueue(), github: new FakeGitHub(), settings: spent, log };
    expect(await dispatchRun(deps, auto.id)).toBe("cancelled");
    expect(await dispatchRun(deps, manual.id)).toBe("dispatched");
  });
});

describe("grader callbacks (per-run token)", () => {
  async function dispatched(s: Scenario) {
    const res = await app.inject({
      method: "POST",
      url: `/v1/submissions/${s.submissionId}/runs`,
      headers: as(s.instructor),
      payload: { sha: sha() },
    });
    const runId = res.json().runId as string;
    const github = new FakeGitHub();
    await dispatchRun({ db, queue: new FakeQueue(), github, settings: roomy, log }, runId);
    return { runId, token: github.dispatches[0]!.inputs.callback_token!, github };
  }
  const post = (url: string, token: string, payload: unknown = {}) =>
    app.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}` }, payload: payload as object });

  const results = {
    infra_error: null,
    stages: [
      { key: "contract", status: "passed", duration_ms: 10 },
      { key: "build", status: "passed", duration_ms: 2000 },
      { key: "health", status: "passed", duration_ms: 500 },
      {
        key: "api",
        status: "failed",
        duration_ms: 1200,
        tests: [
          { id: "todos.list", title: "Lists todos", status: "passed", weight: 1 },
          {
            id: "todos.create",
            title: "Creates a todo",
            category: "API",
            status: "failed",
            weight: 3,
            expected: "201",
            actual: "500",
            hint: "Check the POST /todos handler.",
            evidence: { response: "Internal Server Error" },
            staff_notes: "Usually a missing await",
          },
        ],
      },
    ],
  };

  it("records results, then scores them and posts a check run", async () => {
    const s = await scenario();
    const { runId, token } = await dispatched(s);

    expect((await post(`/v1/runs/${runId}/started`, "wrong")).statusCode).toBe(401);
    expect((await post(`/v1/runs/${runId}/started`, token)).statusCode).toBe(200);
    expect(
      (await db.selectFrom("evaluation_runs").select("status").where("id", "=", runId).executeTakeFirstOrThrow())
        .status,
    ).toBe("running");

    expect((await post(`/v1/runs/${runId}/results`, token, { stages: "nope" })).statusCode).toBe(400);
    queue.sent = [];
    expect((await post(`/v1/runs/${runId}/results`, token, results)).statusCode).toBe(200);
    expect(queue.sent).toEqual([{ name: "score-run", data: { runId } }]);
    const tests = await db
      .selectFrom("test_results")
      .selectAll()
      .where("run_id", "=", runId)
      .orderBy("test_key")
      .execute();
    expect(tests).toMatchObject([
      { test_key: "todos.create", status: "failed", weight: "3.00", staff_notes: "Usually a missing await" },
      { test_key: "todos.list", status: "passed" },
    ]);
    expect(tests[0]!.evidence).toEqual({ response: "Internal Server Error" });

    // Results can't be replaced once the run is finished.
    expect((await post(`/v1/runs/${runId}/results`, token, results)).statusCode).toBe(409);

    const github = new FakeGitHub();
    const deps = { db, queue: new FakeQueue(), github, settings, log };
    expect(await scoreAndReport(deps, runId)).toBe(25);
    expect(github.checkRuns).toHaveLength(1);
    const check = github.checkRuns[0]!;
    expect(check).toMatchObject({ owner: s.owner, repo: s.name, name: "HBE tests", conclusion: "failure" });
    expect(check.title).toBe("1/2 tests passed · score 25");
    expect(check.summary).toContain("Creates a todo");
    expect(check.summary).not.toContain("missing await"); // staff notes stay private
    expect(check.detailsUrl).toBe(
      `http://localhost:3000/i/${s.slug}/courses/${s.courseId}/assignments/${s.assignmentId}/submissions/${s.submissionId}/runs/${runId}`,
    );
    const stored = await db
      .selectFrom("evaluation_runs")
      .select(["score", "check_run_id", "summary"])
      .where("id", "=", runId)
      .executeTakeFirstOrThrow();
    expect(stored).toMatchObject({ score: "25.00", check_run_id: check.id });
    expect(stored.summary).toMatchObject({ passed: 1, failed: 1, total: 2, blockedBy: null });

    // Scoring again doesn't post a second check run.
    await scoreAndReport(deps, runId);
    expect(github.checkRuns).toHaveLength(1);
  });

  it("does not grade infrastructure errors", async () => {
    const s = await scenario();
    const { runId, token } = await dispatched(s);
    await post(`/v1/runs/${runId}/results`, token, { infra_error: "npm registry unreachable", stages: [] });
    const github = new FakeGitHub();
    expect(await scoreAndReport({ db, queue: new FakeQueue(), github, settings, log }, runId)).toBeNull();
    const stored = await db
      .selectFrom("evaluation_runs")
      .select(["status", "score"])
      .where("id", "=", runId)
      .executeTakeFirstOrThrow();
    expect(stored).toEqual({ status: "infra_error", score: null });
    expect(github.checkRuns[0]).toMatchObject({ conclusion: "neutral", title: "The grader could not run" });
  });

  it("rejects callbacks for runs that are not active", async () => {
    const s = await scenario();
    const res = await app.inject({
      method: "POST",
      url: `/v1/submissions/${s.submissionId}/runs`,
      headers: as(s.instructor),
      payload: { sha: sha() },
    });
    const runId = res.json().runId as string;
    const token = "queued-run-token";
    await db
      .updateTable("evaluation_runs")
      .set({ callback_token_hash: hashToken(token) })
      .where("id", "=", runId)
      .execute();
    expect((await post(`/v1/runs/${runId}/started`, token)).statusCode).toBe(409);
    expect((await post(`/v1/runs/${randomUUID()}/started`, token)).statusCode).toBe(404);
  });
});

describe("grader callbacks (GitHub Actions OIDC)", () => {
  let oidcApp: FastifyInstance;
  let sign: (claims: Record<string, unknown>, opts?: { audience?: string; issuer?: string }) => Promise<string>;
  const workflowRef = "hbe-test/hbe-grader/.github/workflows/evaluate.yml@refs/heads/main";

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" }] });
    const oidcSettings = testSettings();
    oidcApp = await buildApp({
      settings: oidcSettings,
      db,
      queue: new FakeQueue(),
      verifier,
      graderAuth: oidcGraderAuth(oidcSettings, jwks),
    });
    sign = (claims, opts = {}) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(opts.issuer ?? "https://token.actions.githubusercontent.com")
        .setAudience(opts.audience ?? "http://localhost:4000")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
  });
  afterAll(async () => {
    await oidcApp.close();
  });

  it("accepts only the grader workflow's token, bound to one workflow run", async () => {
    const s = await scenario();
    const res = await app.inject({
      method: "POST",
      url: `/v1/submissions/${s.submissionId}/runs`,
      headers: as(s.instructor),
      payload: { sha: sha() },
    });
    const runId = res.json().runId as string;
    await db.updateTable("evaluation_runs").set({ status: "dispatched" }).where("id", "=", runId).execute();
    const started = async (token: string) =>
      oidcApp.inject({
        method: "POST",
        url: `/v1/runs/${runId}/started`,
        headers: { authorization: `Bearer ${token}` },
      });
    const good = { repository: "hbe-test/hbe-grader", workflow_ref: workflowRef, run_id: "4242" };

    expect((await started(await sign({ ...good, repository: "someone/else" }))).statusCode).toBe(401);
    expect((await started(await sign({ ...good, workflow_ref: workflowRef.replace("main", "dev") }))).statusCode).toBe(
      401,
    );
    expect((await started(await sign(good, { audience: "https://other.example" }))).statusCode).toBe(401);
    expect((await started(await sign(good, { issuer: "https://evil.example" }))).statusCode).toBe(401);

    expect((await started(await sign(good))).statusCode).toBe(200);
    const run = await db
      .selectFrom("evaluation_runs")
      .select(["status", "gh_workflow_run_id"])
      .where("id", "=", runId)
      .executeTakeFirstOrThrow();
    expect(run).toEqual({ status: "running", gh_workflow_run_id: 4242 });

    // Another workflow run can't report for this evaluation run.
    const other = await oidcApp.inject({
      method: "POST",
      url: `/v1/runs/${runId}/results`,
      headers: { authorization: `Bearer ${await sign({ ...good, run_id: "9999" })}` },
      payload: { stages: [] },
    });
    expect(other.statusCode).toBe(401);
  });
});

describe("reaper", () => {
  it("turns stuck runs into infra errors and re-queues stalled ones", async () => {
    const s = await scenario();
    const insert = (values: { status: "queued" | "dispatched" | "running"; ageMinutes: number }) =>
      db
        .insertInto("evaluation_runs")
        .values({
          institution_id: s.institutionId,
          submission_id: s.submissionId,
          sha: sha(),
          trigger: "manual",
          status: values.status,
          grader_suite_id: null,
          stack_profile_id: null,
          requested_by: null,
          callback_token_hash: null,
          queued_at: sql<Date>`now() - make_interval(mins => ${values.ageMinutes})`,
          dispatched_at: sql<Date>`now() - make_interval(mins => ${values.ageMinutes})`,
          started_at:
            values.status === "running" ? sql<Date>`now() - make_interval(mins => ${values.ageMinutes})` : null,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
    const neverStarted = await insert({ status: "dispatched", ageMinutes: 31 });
    const fresh = await insert({ status: "dispatched", ageMinutes: 5 });
    const hung = await insert({ status: "running", ageMinutes: 40 });
    const stalled = await insert({ status: "queued", ageMinutes: 20 });

    const q = new FakeQueue();
    expect(await reapRuns({ db, queue: q, settings, log })).toBeGreaterThanOrEqual(2);
    const statuses = Object.fromEntries(
      (
        await db
          .selectFrom("evaluation_runs")
          .select(["id", "status"])
          .where("id", "in", [neverStarted.id, fresh.id, hung.id, stalled.id])
          .execute()
      ).map((r) => [r.id, r.status]),
    );
    expect(statuses).toEqual({
      [neverStarted.id]: "infra_error",
      [fresh.id]: "dispatched",
      [hung.id]: "infra_error",
      [stalled.id]: "queued",
    });
    expect(q.sent).toContainEqual({
      name: "dispatch-run",
      data: { runId: stalled.id },
      options: { singletonKey: `dispatch-${stalled.id}` },
    });
  });
});
