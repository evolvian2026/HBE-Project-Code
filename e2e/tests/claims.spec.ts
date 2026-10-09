import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { sendWebhook, signIn, sql } from "./support.ts";

const suffix = Date.now().toString(36);
const email = (who: string) => `${who}-${suffix}@e2e.test`;
const slug = `claim-${suffix}`;
const githubRepoId = Math.floor(Math.random() * 1e9);
const studentGithubId = Math.floor(Math.random() * 1e9);

test.afterAll(async () => {
  await sql("delete from public.institutions where slug = $1", [slug]);
  await sql("delete from auth.users where email like $1", [`%-${suffix}@e2e.test`]);
  await sql("delete from public.github_installations where account_login = $1", [`org-${suffix}`]);
});

test("a student claims commits from an unlinked git email and their instructor confirms", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const [inst] = await sql<{ id: string }>(
    "insert into public.institutions (name, slug) values ($1, $2) returning id",
    [`Claim U ${suffix}`, slug],
  );
  const [gh] = await sql<{ id: string }>(
    "insert into public.github_installations (institution_id, installation_id, account_id, account_login, account_type) values ($1, $2, 1, $3, 'Organization') returning id",
    [inst!.id, Math.floor(Math.random() * 1e9), `org-${suffix}`],
  );
  const [course] = await sql<{ id: string }>(
    "insert into public.courses (institution_id, code, name, term, github_installation_id) values ($1, 'FS310', 'Projects', '2026-T1', $2) returning id",
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
  await sql(
    `insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at, last_sign_in_at)
     values ($1, $2, '{"user_name":"ada-dev"}'::jsonb, 'github', now(), now(), now())`,
    [String(studentGithubId), ada!.id],
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
  const [submission] = await sql<{ id: string }>(
    "insert into public.submissions (institution_id, assignment_id, user_id, repository_id, status) values ($1, $2, $3, $4, 'active') returning id",
    [inst!.id, assignment!.id, ada!.id, repo!.id],
  );
  // One commit GitHub linked to Ada; two from her laptop, whose git email isn't on her account.
  const commit = (daysAgo: number, message: string, mine: boolean) =>
    sql(
      `insert into public.commits (institution_id, repository_id, sha, message, authored_at, author_login, author_email,
                                   author_profile_id, attribution, details_status, parent_count, effective_lines)
       values ($1, $2, $3, $4, now() - make_interval(days => $5), $6, $7, $8, $9, 'done', 1, 30)`,
      [
        inst!.id,
        repo!.id,
        randomUUID().replace(/-/g, "").padEnd(40, "a").slice(0, 40),
        message,
        daysAgo,
        mine ? "ada-dev" : null,
        mine ? "ada@uni.test" : "ada@laptop.test",
        mine ? ada!.id : null,
        mine ? "github" : null,
      ],
    );
  await commit(5, "Add todo model", true);
  await commit(4, "Add CRUD routes", false);
  await commit(3, "Add tests", false);

  // A webhook makes the worker compute the process score.
  await sendWebhook(baseURL!, "issues", {
    action: "opened",
    repository: { id: githubRepoId, full_name: `org-${suffix}/todo-api-ada-dev` },
    issue: {
      id: 1,
      number: 1,
      title: "Set up project",
      state: "open",
      created_at: new Date().toISOString(),
      user: { id: studentGithubId, login: "ada-dev" },
    },
  });
  const unattributed = async () =>
    (
      await sql<{ n: number | null }>(
        "select (breakdown->>'unattributedCommits')::int as n from public.process_snapshots where submission_id = $1",
        [submission!.id],
      )
    )[0]?.n ?? null;
  await expect.poll(unattributed, { timeout: 15_000 }).toBe(2);

  // Ada claims her laptop's commits.
  await student.goto(`/i/${slug}/courses/${course!.id}/assignments/${assignment!.id}`);
  await expect(student.getByText(/2 commits aren't linked to your GitHub account/)).toBeVisible();
  const claims = student.locator("#claims");
  const group = claims.getByTestId("claimable").filter({ hasText: "2 commits by ada@laptop.test" });
  await group.getByLabel("Note for ada@laptop.test").fill("My laptop's git email");
  await group.getByRole("button", { name: "These are mine" }).click();
  await expect(student.getByText("Claimed. Your instructor has been asked to confirm")).toBeVisible();
  await expect(claims.getByTestId("my-claims").getByText("waiting for your instructor")).toHaveCount(2);

  // The instructor confirms them, remembering the email.
  const teacher = await (await browser.newContext()).newPage();
  await signIn(teacher, email("teacher"));
  await teacher.goto(`/i/${slug}/courses/${course!.id}/assignments/${assignment!.id}/submissions/${submission!.id}`);
  const review = teacher.locator("#claims");
  await expect(review.getByTestId("claims").getByText("to review")).toHaveCount(2);
  await expect(review.getByText("“My laptop's git email”").first()).toBeVisible();
  await expect(review.getByLabel("Also credit their later commits from ada@laptop.test")).toBeChecked();
  await review.getByRole("button", { name: "Confirm 2 claims" }).click();
  await expect(teacher.getByText("Claims approved.")).toBeVisible();
  await expect(review.getByTestId("claims").getByText("confirmed")).toHaveCount(2);
  await expect(teacher.getByRole("listitem").filter({ hasText: "Add tests" }).getByText("counts")).toBeVisible();

  // They count for Ada now.
  expect(await unattributed()).toBe(0);
  const [alias] = await sql<{ email: string }>(
    "select email from public.commit_author_aliases where institution_id = $1 and profile_id = $2",
    [inst!.id, ada!.id],
  );
  expect(alias?.email).toBe("ada@laptop.test");
  await student.reload();
  await expect(student.getByText(/aren't linked to your GitHub account/)).toHaveCount(0);
  await expect(claims.getByTestId("my-claims").getByText("confirmed")).toHaveCount(2);
});
