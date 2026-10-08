import { createHmac, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { signIn, sql } from "./support.ts";

const suffix = Date.now().toString(36);
const email = (who: string) => `${who}-${suffix}@e2e.test`;
const slug = `act-${suffix}`;
const WEBHOOK_SECRET = process.env.E2E_WEBHOOK_SECRET ?? "local-secret";
const githubRepoId = Math.floor(Math.random() * 1e9);
const studentGithubId = Math.floor(Math.random() * 1e9);

test.afterAll(async () => {
  await sql("delete from public.institutions where slug = $1", [slug]);
  await sql("delete from auth.users where email like $1", [`%-${suffix}@e2e.test`]);
  await sql("delete from public.github_installations where account_login = $1", [`org-${suffix}`]);
});

/** Sends a webhook signed like GitHub does. */
async function sendWebhook(baseURL: string, event: string, payload: unknown) {
  const body = JSON.stringify(payload);
  const res = await fetch(`${baseURL}/webhooks/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": randomUUID(),
      "x-hub-signature-256": `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`,
    },
    body,
  });
  expect(res.status).toBe(202);
}

test("a student sees their process score and why each commit counted", async ({ page, baseURL }) => {
  // Setup: published assignment with an active repository for a student who linked GitHub.
  const [inst] = await sql<{ id: string }>(
    "insert into public.institutions (name, slug) values ($1, $2) returning id",
    [`Activity U ${suffix}`, slug],
  );
  const [gh] = await sql<{ id: string }>(
    "insert into public.github_installations (institution_id, installation_id, account_id, account_login, account_type) values ($1, $2, 1, $3, 'Organization') returning id",
    [inst!.id, Math.floor(Math.random() * 1e9), `org-${suffix}`],
  );
  const [course] = await sql<{ id: string }>(
    "insert into public.courses (institution_id, code, name, term, github_installation_id) values ($1, 'FS300', 'Projects', '2026-T1', $2) returning id",
    [inst!.id, gh!.id],
  );
  await sql(
    "insert into public.invitations (institution_id, email, role, course_id, course_role) values ($1, $2, 'student', $3, 'student')",
    [inst!.id, email("student"), course!.id],
  );
  await signIn(page, email("student"));
  const [student] = await sql<{ id: string }>("select id from auth.users where email = $1", [email("student")]);
  await sql(
    `insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at, last_sign_in_at)
     values ($1, $2, '{"user_name":"ada-dev"}'::jsonb, 'github', now(), now(), now())`,
    [String(studentGithubId), student!.id],
  );
  const [assignment] = await sql<{ id: string }>(
    `insert into public.assignments (institution_id, course_id, slug, title, stack_profile_id, template_repo, due_at, status, published_at)
     values ($1, $2, 'todo-api', 'Todo API', (select id from public.stack_profiles where key = 'mern-node20'), 't/t', now() + interval '3 days', 'published', now())
     returning id`,
    [inst!.id, course!.id],
  );
  const [repo] = await sql<{ id: string }>(
    "insert into public.repositories (institution_id, github_installation_id, owner, name, github_repo_id) values ($1, $2, $3, 'todo-api-ada-dev', $4) returning id",
    [inst!.id, gh!.id, `org-${suffix}`, githubRepoId],
  );
  await sql(
    "insert into public.submissions (institution_id, assignment_id, user_id, repository_id, status) values ($1, $2, $3, $4, 'active')",
    [inst!.id, assignment!.id, student!.id, repo!.id],
  );
  // Commits with details already fetched: three counted days, one too small, one by someone else.
  const commit = (daysAgo: number, lines: number, message: string, mine = true) =>
    sql(
      `insert into public.commits (institution_id, repository_id, sha, message, authored_at, author_login, author_profile_id,
                                   details_status, parent_count, effective_lines)
       values ($1, $2, $3, $4, now() - make_interval(days => $5), $6, $7, 'done', 1, $8)`,
      [
        inst!.id,
        repo!.id,
        randomUUID().replace(/-/g, "").padEnd(40, "a").slice(0, 40),
        message,
        daysAgo,
        mine ? "ada-dev" : "someone",
        mine ? student!.id : null,
        lines,
      ],
    );
  await commit(6, 40, "Add todo model");
  await commit(5, 25, "Add CRUD routes");
  await commit(4, 30, "Add tests");
  await commit(4, 1, "Fix typo");
  await commit(3, 50, "Code from a friend", false);

  // A signed webhook for an issue makes the worker recompute the score.
  const repository = { id: githubRepoId, full_name: `org-${suffix}/todo-api-ada-dev` };
  const user = { id: studentGithubId, login: "ada-dev" };
  await sendWebhook(baseURL!, "issues", {
    action: "closed",
    repository,
    issue: {
      id: 1,
      number: 1,
      title: "Set up project",
      state: "closed",
      created_at: new Date(Date.now() - 6 * 864e5).toISOString(),
      closed_at: new Date().toISOString(),
      user,
    },
  });
  await expect
    .poll(
      async () =>
        (
          await sql(
            "select 1 from public.process_snapshots ps join public.submissions s on s.id = ps.submission_id where s.repository_id = $1",
            [repo!.id],
          )
        ).length,
      {
        timeout: 15_000,
      },
    )
    .toBe(1);

  // The student sees the breakdown with actionable explanations.
  await page.goto(`/i/${slug}/courses/${course!.id}/assignments/${assignment!.id}`);
  const progress = page.locator("section").filter({ hasText: "Your progress" });
  await expect(
    progress.getByText("Active on 3 of 6 target days. Commit meaningful work on more separate days."),
  ).toBeVisible();
  await expect(progress.getByText("1 of 3 issues opened and closed. Track your tasks as GitHub issues.")).toBeVisible();
  await expect(progress.getByText(/1 commit isn't linked to your GitHub account/)).toBeVisible();

  // And the commit timeline explains each verdict.
  await page.getByRole("link", { name: "See your commit history" }).click();
  const row = (message: string) => page.getByRole("listitem").filter({ hasText: message });
  await expect(row("Add todo model").getByText("counts")).toBeVisible();
  await expect(row("Fix typo").getByText("too small")).toBeVisible();
  await expect(row("Code from a friend").getByText("not linked to the student")).toBeVisible();
});
