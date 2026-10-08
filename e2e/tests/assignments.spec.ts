import { expect, test } from "@playwright/test";
import { signIn, sql } from "./support.ts";

const suffix = Date.now().toString(36);
const email = (who: string) => `${who}-${suffix}@e2e.test`;
const slug = `asg-${suffix}`;

test.afterAll(async () => {
  await sql("delete from public.institutions where slug = $1", [slug]);
  await sql("delete from auth.users where email like $1", [`%-${suffix}@e2e.test`]);
  await sql("delete from public.github_installations where account_login = $1", [`org-${suffix}`]);
});

test("a teacher drafts, completes and publishes an assignment; students see their state", async ({ browser }) => {
  // Setup: institution, a connected GitHub organisation, a course, and invitations.
  const [inst] = await sql<{ id: string }>(
    "insert into public.institutions (name, slug) values ($1, $2) returning id",
    [`Assignment U ${suffix}`, slug],
  );
  const [gh] = await sql<{ id: string }>(
    "insert into public.github_installations (institution_id, installation_id, account_id, account_login, account_type) values ($1, $2, 1, $3, 'Organization') returning id",
    [inst!.id, Math.floor(Math.random() * 1e9), `org-${suffix}`],
  );
  const [course] = await sql<{ id: string }>(
    "insert into public.courses (institution_id, code, name, term, github_installation_id) values ($1, 'FS200', 'Full-Stack Projects', '2026-T1', $2) returning id",
    [inst!.id, gh!.id],
  );
  await sql(
    `insert into public.invitations (institution_id, email, role, course_id, course_role) values
       ($1, $2, 'teacher', $5, 'instructor'), ($1, $3, 'student', $5, 'student'), ($1, $4, 'student', $5, 'student')`,
    [inst!.id, email("teacher"), email("student"), email("ghstudent"), course!.id],
  );

  // Students sign in first (invitations accepted); one links GitHub (simulated identity).
  const studentCtx = await browser.newContext();
  const student = await studentCtx.newPage();
  await signIn(student, email("student"));
  const ghCtx = await browser.newContext();
  const ghStudent = await ghCtx.newPage();
  await signIn(ghStudent, email("ghstudent"));
  await sql(
    `insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at, last_sign_in_at)
     select '${Math.floor(Math.random() * 1e9)}', id, '{"user_name":"gh-student"}'::jsonb, 'github', now(), now(), now()
     from auth.users where email = $1`,
    [email("ghstudent")],
  );

  // The teacher creates a draft.
  const teacherCtx = await browser.newContext();
  const teacher = await teacherCtx.newPage();
  await signIn(teacher, email("teacher"));
  await teacher.goto(`/i/${slug}/courses/${course!.id}`);
  await teacher.getByRole("link", { name: "New assignment" }).click();
  await teacher.getByLabel("Title").fill("Todo API");
  await expect(teacher.getByLabel("Short name")).toHaveValue("todo-api");
  await teacher.getByLabel("Template repository").fill("hbe-templates/mern-starter");
  const suite = teacher.getByLabel("Hidden test suite");
  const sample = await suite.locator("option", { hasText: "Todo API (sample suite)" }).getAttribute("value");
  await suite.selectOption(sample!);
  await teacher.getByLabel("On pull requests").uncheck();
  await teacher
    .getByLabel("Specification (Markdown)")
    .fill("## Goal\n\nBuild a **todo** API.\n\n- `GET /todos`\n- `POST /todos`");
  await teacher.getByRole("button", { name: "Create draft" }).click();
  await expect(teacher.getByRole("heading", { name: /Todo API/ })).toBeVisible();
  await expect(teacher.getByText("draft", { exact: true })).toBeVisible();
  await expect(teacher.getByRole("strong")).toHaveText("todo"); // Markdown rendered
  await expect(teacher.getByText("Todo API (sample suite)")).toBeVisible();

  // Students can't see drafts.
  await student.goto(`/i/${slug}/courses/${course!.id}`);
  await expect(student.getByText("No assignments yet")).toBeVisible();

  // Publishing explains what's missing, then succeeds once the rubric has a criterion.
  await teacher.getByRole("button", { name: "Publish to students" }).click();
  await expect(teacher.getByText("Not ready to publish yet:")).toBeVisible();
  await expect(teacher.getByText("Add rubric criteria, or set the rubric weight to 0.")).toBeVisible();
  await teacher.getByLabel("Criterion").fill("Code quality");
  await teacher.getByRole("button", { name: "Add criterion" }).click();
  await expect(teacher.getByText("10 points")).toBeVisible();
  await teacher.getByRole("button", { name: "Publish to students" }).click();
  await expect(teacher.getByText("Published. 2 students will get a repository.")).toBeVisible();

  // The worker creates the linked student's repository (in-memory GitHub when GITHUB_FAKE=true).
  await expect(async () => {
    await teacher.reload();
    await expect(teacher.getByText("repository ready")).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000 });
  await expect(teacher.getByRole("link", { name: "todo-api-gh-student" })).toBeVisible();
  await expect(teacher.getByText("waiting for GitHub link")).toBeVisible();

  // Once published, the short name is locked.
  await teacher.getByRole("link", { name: "Edit" }).click();
  await expect(teacher.getByLabel("Short name")).toHaveAttribute("readonly", "");

  // Students see the assignment and their own state.
  await student.reload();
  await student.getByRole("link", { name: "Todo API" }).click();
  await expect(student.getByText("Link your GitHub account so we can create your repository")).toBeVisible();
  await expect(student.getByText("Code quality")).toBeVisible();
  await expect(student.getByText("Submissions")).toHaveCount(0);

  await ghStudent.goto(`/i/${slug}/courses/${course!.id}`);
  await ghStudent.getByRole("link", { name: "Todo API" }).click();
  await expect(ghStudent.getByRole("link", { name: /todo-api-gh-student/ })).toBeVisible();

  for (const ctx of [studentCtx, ghCtx, teacherCtx]) await ctx.close();
});
