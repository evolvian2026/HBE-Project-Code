import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { signIn, sql } from "./support.ts";

// The app runs with GITHUB_FAKE_GIT_ROOT set to the same directory: the fake GitHub serves
// student repositories from git repositories there.
const gitRoot = process.env.E2E_FAKE_GIT_ROOT ?? "/tmp/hbe-fake-github";
const suffix = Date.now().toString(36);
const email = (who: string) => `${who}-${suffix}@e2e.test`;
const slug = `review-${suffix}`;
const owner = `org-${suffix}`;
const repoDir = path.join(gitRoot, owner, "todo-api-ada");

test.afterAll(async () => {
  await sql("delete from public.institutions where slug = $1", [slug]);
  await sql("delete from auth.users where email like $1", [`%-${suffix}@e2e.test`]);
  await sql("delete from public.github_installations where account_login = $1", [owner]);
  rmSync(path.join(gitRoot, owner), { recursive: true, force: true });
});

test("staff review the student's code, comment inline, and the student sees it after release", async ({ browser }) => {
  // The student's repository: the template's commit, then their work.
  mkdirSync(path.join(repoDir, "src"), { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repoDir, "-c", "user.name=Ada", "-c", "user.email=ada@example.test", ...args], {
      encoding: "utf8",
    }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(path.join(repoDir, "README.md"), "# Todo API\n");
  writeFileSync(path.join(repoDir, "src", "server.js"), "// TODO: build the API\n");
  git("add", ".");
  git("commit", "-q", "-m", "Initial commit");
  writeFileSync(
    path.join(repoDir, "src", "server.js"),
    "import http from 'node:http';\nconst todos = [];\nhttp.createServer((req, res) => res.end(JSON.stringify(todos))).listen(4000);\n",
  );
  git("commit", "-q", "-am", "Serve todos");
  const head = git("rev-parse", "HEAD");

  const [inst] = await sql<{ id: string }>(
    "insert into public.institutions (name, slug) values ($1, $2) returning id",
    [`Review U ${suffix}`, slug],
  );
  const [gh] = await sql<{ id: string }>(
    "insert into public.github_installations (institution_id, installation_id, account_id, account_login, account_type) values ($1, $2, 1, $3, 'Organization') returning id",
    [inst!.id, Math.floor(Math.random() * 1e9), owner],
  );
  const [course] = await sql<{ id: string }>(
    "insert into public.courses (institution_id, code, name, term, github_installation_id) values ($1, 'FS600', 'Review', '2026-T1', $2) returning id",
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
  const studentCtx = await browser.newContext();
  const student = await studentCtx.newPage();
  const teacherCtx = await browser.newContext();
  const teacher = await teacherCtx.newPage();
  await signIn(student, email("student"));
  await signIn(teacher, email("teacher"));
  const [studentRow] = await sql<{ id: string }>("select id from auth.users where email = $1", [email("student")]);
  const [assignment] = await sql<{ id: string }>(
    `insert into public.assignments (institution_id, course_id, slug, title, stack_profile_id, template_repo, due_at, status, published_at)
     values ($1, $2, 'todo-api', 'Todo API', (select id from public.stack_profiles where key = 'node22-api'), 't/t',
             now() + interval '3 days', 'published', now())
     returning id`,
    [inst!.id, course!.id],
  );
  const [repo] = await sql<{ id: string }>(
    "insert into public.repositories (institution_id, github_installation_id, owner, name, github_repo_id, head_sha) values ($1, $2, $3, 'todo-api-ada', $4, $5) returning id",
    [inst!.id, gh!.id, owner, Math.floor(Math.random() * 1e9), head],
  );
  const [submission] = await sql<{ id: string }>(
    "insert into public.submissions (institution_id, assignment_id, user_id, repository_id, status) values ($1, $2, $3, $4, 'active') returning id",
    [inst!.id, assignment!.id, studentRow!.id, repo!.id],
  );
  const submissionUrl = `/i/${slug}/courses/${course!.id}/assignments/${assignment!.id}/submissions/${submission!.id}`;

  // The instructor browses the code at the latest push and comments on a line.
  await teacher.goto(submissionUrl);
  await teacher.getByRole("link", { name: "Review code" }).click();
  const tree = teacher.getByTestId("file-tree");
  await tree.getByText("src/").click();
  await tree.getByRole("link", { name: "server.js" }).click();
  const file = teacher.getByTestId("file-view");
  await expect(file.getByText("const todos = [];")).toBeVisible();
  await file.getByRole("link", { name: "Comment on line 2" }).click();
  await teacher.getByLabel("Your comment on line 2").fill("Keep todos in a Map keyed by id.");
  await teacher.getByRole("button", { name: "Add comment" }).click();
  await expect(file.getByText("Keep todos in a Map keyed by id.")).toBeVisible();

  // What changed since the template.
  await teacher.getByRole("link", { name: "Changes since the start" }).click();
  const changes = teacher.getByTestId("changes");
  await expect(changes.getByText("1 files changed in 1 commit(s)", { exact: false })).toBeVisible();
  await expect(changes.getByText("+const todos = [];")).toBeVisible();
  await expect(changes.getByText("-// TODO: build the API")).toBeVisible();

  // The student sees review comments once grades are released.
  await student.goto(submissionUrl);
  await expect(student.getByRole("heading", { name: "Commits" })).toBeVisible();
  await expect(student.getByTestId("code-comments")).toHaveCount(0);
  await sql("update public.submissions set grade_released_at = now() where id = $1", [submission!.id]);
  await student.reload();
  const comments = student.getByTestId("code-comments");
  await expect(comments.getByText("Keep todos in a Map keyed by id.")).toBeVisible();
  await expect(comments.getByRole("link", { name: "src/server.js:2" })).toHaveAttribute(
    "href",
    `https://github.com/${owner}/todo-api-ada/blob/${head}/src/server.js#L2`,
  );

  await studentCtx.close();
  await teacherCtx.close();
});
