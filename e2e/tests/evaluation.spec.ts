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
  test.setTimeout(240_000);

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
                                     due_at, status, published_at, run_quota_per_day)
     values ($1, $2, 'todo-api', 'Todo API', (select id from public.stack_profiles where key = 'node22-api'),
             (select id from public.grader_suites where key = 'todo-api' and institution_id is null), 't/t',
             now() + interval '3 days', 'published', now(), 3)
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
  await expect
    .poll(
      async () =>
        (await sql<{ status: string }>("select status from public.evaluation_runs where id = $1", [runId]))[0]?.status,
      {
        timeout: 30_000,
      },
    )
    .toBe("dispatched");
  const token = randomBytes(24).toString("base64url");
  await sql("update public.evaluation_runs set callback_token_hash = $2 where id = $1", [
    runId,
    createHash("sha256").update(token).digest("hex"),
  ]);
  const [profile] = await sql<{ definition: object }>(
    "select jsonb_build_object('key', key, 'version', version) || definition as definition from public.stack_profiles where key = 'node22-api'",
  );
  await promisify(execFile)(
    process.execPath,
    [
      path.join(grader, "harness/run.mjs"),
      ...["--run-id", runId, "--sha", headSha],
      ...["--submission", path.join(grader, "test-fixtures/todo-api-buggy")],
      ...["--suite", path.join(grader, "suites/sample/todo-api")],
      ...["--profile", JSON.stringify(profile!.definition)],
      ...["--api-url", baseURL!, "--token", token, "--timeout-minutes", "5"],
      ...["--out", path.join(test.info().outputDir, "results.json")],
    ],
    { timeout: 180_000 },
  );

  // The page updates by itself: the score, and each failure with what was expected.
  await expect(page.getByText("5 of 7 tests passed.")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("70 / 100")).toBeVisible();
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
  await expect(tests.getByText("5/7 passed · 70")).toBeVisible();

  // The instructor sees the same run, with the staff notes.
  const teacherContext = await browser.newContext();
  const teacher = await teacherContext.newPage();
  await signIn(teacher, email("teacher"));
  await teacher.goto(assignmentUrl);
  await expect(teacher.getByText("tests 5/7 passed · 70")).toBeVisible();
  await teacher.goto(`${assignmentUrl}/submissions/${submission!.id}/runs/${runId}`);
  await expect(
    teacher.getByTestId("test-todos.delete").getByText(/usually means the delete handler is a stub/),
  ).toBeVisible();
  await teacherContext.close();
});
