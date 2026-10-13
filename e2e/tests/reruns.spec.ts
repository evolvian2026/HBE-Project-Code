import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { reportRun, signIn, sql } from "./support.ts";

const suffix = Date.now().toString(36);
const email = (who: string) => `${who}-${suffix}@e2e.test`;
const slug = `rerun-${suffix}`;

test.afterAll(async () => {
  await sql("delete from public.institutions where slug = $1", [slug]);
  await sql("delete from auth.users where email like $1", [`%-${suffix}@e2e.test`]);
  await sql("delete from public.github_installations where account_login = $1", [`org-${suffix}`]);
});

test("an instructor re-runs everyone's tests and watches the re-run finish", async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const [inst] = await sql<{ id: string }>(
    "insert into public.institutions (name, slug) values ($1, $2) returning id",
    [`Rerun U ${suffix}`, slug],
  );
  const [gh] = await sql<{ id: string }>(
    "insert into public.github_installations (institution_id, installation_id, account_id, account_login, account_type) values ($1, $2, 1, $3, 'Organization') returning id",
    [inst!.id, Math.floor(Math.random() * 1e9), `org-${suffix}`],
  );
  const [course] = await sql<{ id: string }>(
    "insert into public.courses (institution_id, code, name, term, github_installation_id) values ($1, 'FS410', 'APIs', '2026-T1', $2) returning id",
    [inst!.id, gh!.id],
  );
  await sql(
    `insert into public.invitations (institution_id, email, role, course_id, course_role) values
       ($1, $2, 'student', $3, 'student'), ($1, $4, 'teacher', $3, 'instructor')`,
    [inst!.id, email("student"), course!.id, email("teacher")],
  );
  const student = await (await browser.newContext()).newPage();
  await signIn(student, email("student"));
  const [ada] = await sql<{ id: string }>("select id from auth.users where email = $1", [email("student")]);
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
    [inst!.id, gh!.id, `org-${suffix}`, Math.floor(Math.random() * 1e9), randomBytes(20).toString("hex")],
  );
  await sql(
    "insert into public.submissions (institution_id, assignment_id, user_id, repository_id, status) values ($1, $2, $3, $4, 'active')",
    [inst!.id, assignment!.id, ada!.id, repo!.id],
  );
  const assignmentUrl = `/i/${slug}/courses/${course!.id}/assignments/${assignment!.id}`;

  // The instructor re-runs everyone.
  const teacher = await (await browser.newContext()).newPage();
  await signIn(teacher, email("teacher"));
  await teacher.goto(assignmentUrl);
  const card = teacher.locator("section").filter({ hasText: "Re-run tests" });
  await expect(card.getByLabel("Test suite version")).toHaveValue(
    (
      await sql<{ id: string }>("select id from public.grader_suites where key = 'todo-api' and institution_id is null")
    )[0]!.id,
  );
  await card.getByRole("button", { name: "Re-run tests" }).click();
  await expect(card.getByText("Queued 1 run.")).toBeVisible();
  const batches = card.getByTestId("rerun-batches");
  await expect(batches).toContainText("1 run · Todo API");
  await expect(batches.getByText("0 of 1 finished")).toBeVisible();

  // The worker dispatches it; the grader reports back, and the page follows.
  const runId = async () =>
    (
      await sql<{ id: string; status: string }>(
        "select e.id, e.status from public.evaluation_runs e join public.run_batches b on b.id = e.batch_id where b.assignment_id = $1",
        [assignment!.id],
      )
    )[0];
  await expect.poll(async () => (await runId())?.status, { timeout: 30_000 }).toBe("dispatched");
  await reportRun(baseURL!, (await runId())!.id, {
    stages: [
      {
        key: "api",
        status: "passed",
        tests: [{ id: "todos.create", title: "Creates a todo", status: "passed" }],
      },
    ],
  });
  await expect(batches.getByText("done")).toBeVisible({ timeout: 30_000 });

  // The student's own runs for today are untouched.
  await student.goto(assignmentUrl);
  await expect(student.getByText("3 of 3 test runs left today.")).toBeVisible();
});
