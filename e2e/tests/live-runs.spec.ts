import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { signIn, sql } from "./support.ts";

const suffix = Date.now().toString(36);
const email = (who: string) => `${who}-${suffix}@e2e.test`;
const slug = `live-${suffix}`;

test.afterAll(async () => {
  await sql("delete from public.institutions where slug = $1", [slug]);
  await sql("delete from auth.users where email like $1", [`%-${suffix}@e2e.test`]);
  await sql("delete from public.github_installations where account_login = $1", [`org-${suffix}`]);
});

test("test runs show up and change live, without reloading, for those allowed to see them", async ({ browser }) => {
  test.setTimeout(90_000);
  const [inst] = await sql<{ id: string }>(
    "insert into public.institutions (name, slug) values ($1, $2) returning id",
    [`Live U ${suffix}`, slug],
  );
  const [gh] = await sql<{ id: string }>(
    "insert into public.github_installations (institution_id, installation_id, account_id, account_login, account_type) values ($1, $2, 1, $3, 'Organization') returning id",
    [inst!.id, Math.floor(Math.random() * 1e9), `org-${suffix}`],
  );
  const [course] = await sql<{ id: string }>(
    "insert into public.courses (institution_id, code, name, term, github_installation_id) values ($1, 'FS420', 'APIs', '2026-T1', $2) returning id",
    [inst!.id, gh!.id],
  );
  await sql(
    `insert into public.invitations (institution_id, email, role, course_id, course_role) values
       ($1, $2, 'student', $3, 'student'), ($1, $4, 'student', $3, 'student')`,
    [inst!.id, email("ada"), course!.id, email("grace")],
  );
  const ada = await (await browser.newContext()).newPage();
  const grace = await (await browser.newContext()).newPage();
  await signIn(ada, email("ada"));
  await signIn(grace, email("grace"));
  const users = await sql<{ id: string; email: string }>("select id, email from auth.users where email = any($1)", [
    [email("ada"), email("grace")],
  ]);
  const [assignment] = await sql<{ id: string }>(
    `insert into public.assignments (institution_id, course_id, slug, title, stack_profile_id, grader_suite_id, template_repo,
                                     due_at, status, published_at, triggers)
     values ($1, $2, 'todo-api', 'Todo API', (select id from public.stack_profiles where key = 'node22-api'),
             (select id from public.grader_suites where key = 'todo-api' and institution_id is null), 't/t',
             now() + interval '3 days', 'published', now(), '{"on_push": true, "on_pull_request": true, "manual": false}')
     returning id`,
    [inst!.id, course!.id],
  );
  const submissions: Record<string, string> = {};
  for (const u of users) {
    const [repo] = await sql<{ id: string }>(
      "insert into public.repositories (institution_id, github_installation_id, owner, name, github_repo_id) values ($1, $2, $3, $4, $5) returning id",
      [inst!.id, gh!.id, `org-${suffix}`, `todo-api-${u.id.slice(0, 8)}`, Math.floor(Math.random() * 1e9)],
    );
    const [s] = await sql<{ id: string }>(
      "insert into public.submissions (institution_id, assignment_id, user_id, repository_id, status) values ($1, $2, $3, $4, 'active') returning id",
      [inst!.id, assignment!.id, u.id, repo!.id],
    );
    submissions[u.email] = s!.id;
  }
  const url = `/i/${slug}/courses/${course!.id}/assignments/${assignment!.id}`;
  for (const page of [ada, grace]) {
    await page.goto(url);
    await expect(page.getByText("No test runs yet")).toBeVisible();
    // Nothing is in progress, so nothing polls: only Realtime can bring changes.
    await expect(page.getByTestId("live-runs")).toHaveAttribute("data-live", "on", { timeout: 15_000 });
  }

  // A push queues a run on Ada's repository; then the grader finishes it.
  const sha = randomBytes(20).toString("hex");
  const [run] = await sql<{ id: string }>(
    "insert into public.evaluation_runs (institution_id, submission_id, sha, trigger, status) values ($1, $2, $3, 'push', 'queued') returning id",
    [inst!.id, submissions[email("ada")], sha],
  );
  const tests = ada.locator("section").filter({ hasText: "Automated tests" });
  await expect(tests.getByText(sha.slice(0, 7))).toBeVisible({ timeout: 10_000 });
  await sql(
    `update public.evaluation_runs set status = 'completed', score = 80, finished_at = now(),
       summary = '{"stages": [], "passed": 4, "total": 5}' where id = $1`,
    [run!.id],
  );
  await expect(tests.getByText("4/5 passed · 80")).toBeVisible({ timeout: 10_000 });

  // Grace isn't sent Ada's run.
  await grace.waitForTimeout(1500);
  await expect(grace.getByText("No test runs yet")).toBeVisible();
  await expect(grace.getByText(sha.slice(0, 7))).toHaveCount(0);
});
