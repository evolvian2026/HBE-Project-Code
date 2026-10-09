import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { signIn, sql } from "./support.ts";

// Needs Docker: the real grader harness builds and tests a fixture app.
const grader = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../grader");
const suffix = Date.now().toString(36);
const email = (who: string) => `${who}-${suffix}@e2e.test`;
const slug = `eval-${suffix}`;
const headSha = randomBytes(20).toString("hex");

test.afterAll(async () => {
  await sql("delete from public.institutions where slug = $1", [slug]);
  await sql("delete from auth.users where email like $1", [`%-${suffix}@e2e.test`]);
  await sql("delete from public.github_installations where account_login = $1", [`org-${suffix}`]);
});

test("a student runs the hidden tests and sees what to fix", async ({ page, baseURL, browser }) => {
  test.setTimeout(480_000);

  // Setup: a published assignment with the sample suite, and a student with an active repository.
  const [inst] = await sql<{ id: string }>(
    "insert into public.institutions (name, slug) values ($1, $2) returning id",
    [`Eval U ${suffix}`, slug],
  );
  const [gh] = await sql<{ id: string }>(
    "insert into public.github_installations (institution_id, installation_id, account_id, account_login, account_type) values ($1, $2, 1, $3, 'Organization') returning id",
    [inst!.id, Math.floor(Math.random() * 1e9), `org-${suffix}`],
  );
  const [course] = await sql<{ id: string }>(
    "insert into public.courses (institution_id, code, name, term, github_installation_id) values ($1, 'FS400', 'APIs', '2026-T1', $2) returning id",
    [inst!.id, gh!.id],
  );
  for (const [who, role, courseRole] of [
    ["student", "student", "student"],
    ["teacher", "teacher", "instructor"],
  ] as const) {
    await sql(
      "insert into public.invitations (institution_id, email, role, course_id, course_role) values ($1, $2, $3, $4, $5)",
      [inst!.id, email(who), role, course!.id, courseRole],
    );
  }
  await signIn(page, email("student"));
  const [student] = await sql<{ id: string }>("select id from auth.users where email = $1", [email("student")]);
  const [assignment] = await sql<{ id: string }>(
    `insert into public.assignments (institution_id, course_id, slug, title, stack_profile_id, grader_suite_id, template_repo,
                                     due_at, status, published_at, run_quota_per_day, stage_settings)
     values ($1, $2, 'todo-api', 'Todo API', (select id from public.stack_profiles where key = 'node22-api'),
             (select id from public.grader_suites where key = 'todo-api' and institution_id is null), 't/t',
             now() + interval '3 days', 'published', now(), 3,
             '{"lint": {"enabled": true, "share": 10}, "student_tests": {"enabled": true, "share": 20}}')
     returning id`,
    [inst!.id, course!.id],
  );
  const [repo] = await sql<{ id: string }>(
    "insert into public.repositories (institution_id, github_installation_id, owner, name, github_repo_id, head_sha) values ($1, $2, $3, 'todo-api-ada', $4, $5) returning id",
    [inst!.id, gh!.id, `org-${suffix}`, Math.floor(Math.random() * 1e9), headSha],
  );
  const [submission] = await sql<{ id: string }>(
    "insert into public.submissions (institution_id, assignment_id, user_id, repository_id, status) values ($1, $2, $3, $4, 'active') returning id",
    [inst!.id, assignment!.id, student!.id, repo!.id],
  );
  const assignmentUrl = `/i/${slug}/courses/${course!.id}/assignments/${assignment!.id}`;

  // The student starts a run on their latest push.
  await page.goto(assignmentUrl);
  const tests = page.locator("section").filter({ hasText: "Automated tests" });
  await expect(tests.getByText("3 of 3 test runs left today.")).toBeVisible();
  await tests.getByRole("button", { name: "Run tests" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: /Test run/ })).toBeVisible();
  const runId = page.url().split("/").at(-1)!;

  // The worker dispatches it to the grader (an in-memory GitHub here). Act as that grader:
  // give the run a token we know, then run the real harness against a buggy submission.
  const [profile] = await sql<{ definition: object }>(
    "select jsonb_build_object('key', key, 'version', version) || definition as definition from public.stack_profiles where key = 'node22-api'",
  );
  const grade = async (id: string, suite: string, options?: object) => {
    await expect
      .poll(
        async () =>
          (await sql<{ status: string }>("select status from public.evaluation_runs where id = $1", [id]))[0]?.status,
        { timeout: 30_000 },
      )
      .toBe("dispatched");
    const token = randomBytes(24).toString("base64url");
    await sql("update public.evaluation_runs set callback_token_hash = $2 where id = $1", [
      id,
      createHash("sha256").update(token).digest("hex"),
    ]);
    await promisify(execFile)(
      process.execPath,
      [
        path.join(grader, "harness/run.mjs"),
        ...["--run-id", id, "--sha", headSha],
        ...["--submission", path.join(grader, "test-fixtures/todo-api-buggy")],
        ...["--suite", path.join(grader, suite)],
        ...["--profile", JSON.stringify({ ...profile!.definition, ...(options ? { options } : {}) })],
        ...["--api-url", baseURL!, "--token", token, "--timeout-minutes", "5"],
        ...["--out", path.join(test.info().outputDir, `results-${id}.json`)],
      ],
      { timeout: 300_000 },
    );
  };
  // What the worker sends for this assignment: the profile, with lint and the student's tests on.
  await grade(runId, "suites/sample/todo-api", {
    stages: { lint: { share: 10 }, student_tests: { share: 20 } },
    skip_kinds: [],
  });

  // The page updates by itself: the score, and each failure with what was expected.
  // 10% lint (passed) + 20% own tests (one failed) + 70% × 70% of the hidden tests' weight = 59.
  await expect(page.getByText("6 of 9 tests passed.")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("59 / 100")).toBeVisible();
  await expect(page.getByText("Lint · 10% of the score")).toBeVisible();
  const own = page.getByTestId("test-student_tests");
  await expect(own.getByText("1 of 2 tests failed.")).toBeVisible();
  await own.getByText("Failing tests", { exact: true }).click();

  // The run's files are kept: logs, the student's test output and JUnit report.
  const runFiles = page.getByTestId("run-files");
  for (const name of ["Build log", "Your app's logs", "Your tests' output", "Your tests' JUnit report"]) {
    await expect(runFiles.getByRole("link", { name })).toBeVisible();
  }
  const appLog = await page.request.get(
    (await runFiles.getByRole("link", { name: "Your app's logs" }).getAttribute("href"))!,
  );
  expect(await appLog.text()).toContain("todo api listening");
  await expect(own.getByText(/✗ test › rejects an empty title/)).toBeVisible();
  const validation = page.getByTestId("test-todos.create-requires-title");
  await expect(validation.getByText("POST /todos with a blank title should answer 400 Bad Request")).toBeVisible();
  await expect(validation.getByText("HTTP 400", { exact: true })).toBeVisible();
  await expect(validation.getByText("HTTP 201", { exact: true })).toBeVisible();
  await expect(validation.getByText(/answer 400 Bad Request when the title is missing or blank/)).toBeVisible();
  const deletion = page.getByTestId("test-todos.delete");
  await deletion.getByText("Your app's logs").click();
  await expect(deletion.getByText(/not implemented yet/)).toBeVisible();
  // Staff notes are never sent to students.
  await expect(page.getByText(/Staff note/)).toHaveCount(0);

  // One of today's runs is used.
  await page.goto(assignmentUrl);
  await expect(tests.getByText("2 of 3 test runs left today.")).toBeVisible();
  await expect(tests.getByText("6/9 passed · 59")).toBeVisible();

  // The instructor sees the same run, with the staff notes.
  const teacherContext = await browser.newContext();
  const teacher = await teacherContext.newPage();
  await signIn(teacher, email("teacher"));
  await teacher.goto(assignmentUrl);
  await expect(teacher.getByText("tests 6/9 passed · 59")).toBeVisible();
  await teacher.goto(`${assignmentUrl}/submissions/${submission!.id}/runs/${runId}`);
  await expect(
    teacher.getByTestId("test-todos.delete").getByText(/usually means the delete handler is a stub/),
  ).toBeVisible();

  // Browser tests: the instructor switches to the sample browser suite and runs it. The failed
  // test shows a screenshot of the page and offers its Playwright trace.
  await sql(
    "update public.assignments set grader_suite_id = (select id from public.grader_suites where key = 'todo-web' and institution_id is null) where id = $1",
    [assignment!.id],
  );
  await teacher.goto(`${assignmentUrl}/submissions/${submission!.id}`);
  await teacher.getByRole("button", { name: "Run tests" }).click();
  await expect(teacher).toHaveURL(/\/runs\/[0-9a-f-]{36}$/);
  await grade(teacher.url().split("/").at(-1)!, "suites/sample/todo-web");
  const add = teacher.getByTestId("test-ui.add");
  const shot = add.getByRole("img", { name: "The page when “Adds a todo from the form” failed" });
  await expect(shot).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => shot.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await expect(add.getByText(/^See “.+” in the list: locator.waitFor/)).toBeVisible();
  const trace = await teacher.request.get(
    (await add.getByRole("link", { name: "Download the Playwright trace" }).getAttribute("href"))!,
  );
  expect((await trace.body()).subarray(0, 2).toString()).toBe("PK");
  await teacherContext.close();
});
