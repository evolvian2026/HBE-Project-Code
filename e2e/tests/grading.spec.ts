import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { reportRun, sendWebhook, signIn, sql } from "./support.ts";

const suffix = Date.now().toString(36);
const email = (who: string) => `${who}-${suffix}@e2e.test`;
const slug = `grade-${suffix}`;
const githubRepoId = Math.floor(Math.random() * 1e9);
const studentGithubId = Math.floor(Math.random() * 1e9);
const HOUR = 3_600_000;

test.afterAll(async () => {
  await sql("delete from public.institutions where slug = $1", [slug]);
  await sql("delete from auth.users where email like $1", [`%-${suffix}@e2e.test`]);
  await sql("delete from public.github_installations where account_login = $1", [`org-${suffix}`]);
});

const poll = <T>(fn: () => Promise<T>, timeout = 90_000) => expect.poll(fn, { timeout, intervals: [1000] });

test("work pushed before the deadline is graded, reviewed, released and adjusted", async ({ browser, baseURL }) => {
  test.setTimeout(240_000);

  // A course with a student and an instructor, and an assignment whose deadline passed an hour ago.
  const [inst] = await sql<{ id: string }>(
    "insert into public.institutions (name, slug) values ($1, $2) returning id",
    [`Grade U ${suffix}`, slug],
  );
  const [gh] = await sql<{ id: string }>(
    "insert into public.github_installations (institution_id, installation_id, account_id, account_login, account_type) values ($1, $2, 1, $3, 'Organization') returning id",
    [inst!.id, Math.floor(Math.random() * 1e9), `org-${suffix}`],
  );
  const [course] = await sql<{ id: string }>(
    "insert into public.courses (institution_id, code, name, term, github_installation_id) values ($1, 'FS500', 'Capstone', '2026-T1', $2) returning id",
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
    `insert into public.assignments (institution_id, course_id, slug, title, stack_profile_id, grader_suite_id, template_repo,
                                     due_at, status, published_at, weights, late_policy)
     values ($1, $2, 'todo-api', 'Todo API', (select id from public.stack_profiles where key = 'node22-api'),
             (select id from public.grader_suites where key = 'todo-api' and institution_id is null), 't/t',
             now() - interval '1 hour', 'published', now() - interval '2 days',
             '{"automated": 60, "rubric": 25, "process": 15}',
             '{"per_day_percent": 10, "max_days": 0, "grace_minutes": 15}')
     returning id`,
    [inst!.id, course!.id],
  );
  await sql(
    "insert into public.assignment_criteria (institution_id, assignment_id, title, max_points) values ($1, $2, 'Code quality', 10)",
    [inst!.id, assignment!.id],
  );
  const [repo] = await sql<{ id: string }>(
    "insert into public.repositories (institution_id, github_installation_id, owner, name, github_repo_id) values ($1, $2, $3, 'todo-api-ada', $4) returning id",
    [inst!.id, gh!.id, `org-${suffix}`, githubRepoId],
  );
  // The student pushed two hours ago, before the deadline (GitHub's push time decides).
  const sha = randomBytes(20).toString("hex");
  await sendWebhook(baseURL!, "push", {
    ref: "refs/heads/main",
    after: sha,
    repository: {
      id: githubRepoId,
      full_name: `org-${suffix}/todo-api-ada`,
      pushed_at: Math.floor((Date.now() - 2 * HOUR) / 1000),
    },
    sender: { id: studentGithubId, login: "ada-dev", type: "User" },
    commits: [{ id: sha, message: "Finish the API", timestamp: new Date(Date.now() - 2 * HOUR).toISOString() }],
  });
  // The submission appears once the push is on record, so the cutoff job can't fix it as missing first.
  await poll(async () => {
    const [p] = await sql<{ n: number }>(
      "select count(*)::int as n from public.branch_pushes where repository_id = $1",
      [repo!.id],
    );
    return p?.n;
  }, 15_000).toBe(1);
  const [submission] = await sql<{ id: string }>(
    "insert into public.submissions (institution_id, assignment_id, user_id, repository_id, status) values ($1, $2, $3, $4, 'active') returning id",
    [inst!.id, assignment!.id, studentRow!.id, repo!.id],
  );

  // Within a minute the cutoff job fixes the graded commit and queues the deadline run.
  await poll(async () => {
    const [s] = await sql<{ final_sha: string | null }>("select final_sha from public.submissions where id = $1", [
      submission!.id,
    ]);
    return s?.final_sha;
  }).toBe(sha);
  let runId = "";
  await poll(async () => {
    const [r] = await sql<{ id: string; status: string }>(
      "select id, status from public.evaluation_runs where submission_id = $1 and trigger = 'deadline'",
      [submission!.id],
    );
    runId = r?.id ?? "";
    return r?.status;
  }).toBe("dispatched");
  const test_ = (id: string, status: string) => ({ id, title: id, status, weight: 1 });
  await reportRun(baseURL!, runId, {
    stages: [
      { key: "contract", status: "passed", duration_ms: 5 },
      { key: "build", status: "passed", duration_ms: 5 },
      { key: "health", status: "passed", duration_ms: 5 },
      { key: "api", status: "failed", duration_ms: 5, tests: [test_("a", "passed"), test_("b", "failed")] },
    ],
  });

  // The instructor sees the calculated grade waiting for the rubric, scores it and writes feedback.
  const submissionUrl = `/i/${slug}/courses/${course!.id}/assignments/${assignment!.id}/submissions/${submission!.id}`;
  await poll(async () => {
    const [g] = await sql<{ n: number }>(
      "select count(*)::int as n from public.grades where submission_id = $1 and evaluation_run_id is not null",
      [submission!.id],
    );
    return g?.n;
  }, 30_000).toBeGreaterThan(0);
  await teacher.goto(submissionUrl);
  const grading = teacher.locator("section").filter({ hasText: "Grading" });
  await expect(grading.getByText("Still needed: rubric scores for 1 criterion.")).toBeVisible();
  await grading.getByLabel("Points for Code quality").fill("8");
  await grading.getByLabel("Comment").fill("Clear structure; name things consistently.");
  await grading.getByLabel("Feedback for the student (Markdown)").fill("## Well done\n\nAdd a **README** next time.");
  await grading.getByRole("button", { name: "Save review" }).click();
  // 0.6 × 50 (tests) + 0.25 × 80 (rubric) + 0.15 × 0 (no counted activity)
  await expect(grading.getByText("Saved. Grade: 50.")).toBeVisible();

  // Nothing is visible to the student until release.
  const assignmentUrl = `/i/${slug}/courses/${course!.id}/assignments/${assignment!.id}`;
  await student.goto(assignmentUrl);
  await expect(student.getByText("Your submission")).toBeVisible();
  await expect(student.getByText("Your grade")).toHaveCount(0);

  await teacher.goto(assignmentUrl);
  await teacher.getByRole("button", { name: "Release grades" }).click();
  await expect(teacher.getByText("Released 1 grade.")).toBeVisible();

  await student.reload();
  const card = student.locator("section").filter({ hasText: "Your grade" });
  await expect(card.getByTestId("final-grade")).toHaveText("50 / 100");
  await expect(card.getByText("Clear structure; name things consistently.")).toBeVisible();
  await expect(card.getByRole("strong")).toHaveText("README");

  // Release wrote a grade report the student can download (from private Storage).
  const reports = async () =>
    (
      await sql<{ n: number }>("select count(*)::int as n from public.grade_reports where submission_id = $1", [
        submission!.id,
      ])
    )[0]?.n;
  await poll(reports, 30_000).toBe(1);
  await student.reload();
  const pdf = await student.request.get(
    (await card.getByRole("link", { name: "Grade report (PDF)" }).getAttribute("href"))!,
  );
  expect(pdf.headers()["content-type"]).toContain("application/pdf");
  expect((await pdf.body()).subarray(0, 5).toString()).toBe("%PDF-");

  // An override with a reason: the student sees the new grade, not the reason.
  await teacher.goto(submissionUrl);
  await grading.getByLabel("Final grade").fill("55");
  await grading.getByLabel("Reason (staff only)").fill("Bonus for the excellent tests");
  await grading.getByRole("button", { name: "Override grade" }).click();
  await expect(grading.getByText("Grade overridden.")).toBeVisible();

  await student.reload();
  await expect(card.getByTestId("final-grade")).toHaveText("55 / 100");
  await expect(card.getByText(/Adjusted by your instructor/)).toBeVisible();
  await expect(student.getByText("Bonus for the excellent tests")).toHaveCount(0);

  // The change made a second report version; the reason stays out of it.
  await poll(reports, 30_000).toBe(2);
  await student.reload();
  const json = await student.request.get((await card.getByRole("link", { name: "JSON" }).getAttribute("href"))!);
  const report = await json.json();
  expect(report).toMatchObject({ report: { version: 2 }, grade: { final: 55, computed: 50, adjusted_by_staff: true } });
  expect(JSON.stringify(report)).not.toContain("Bonus for the excellent tests");

  // The course dashboard shows the released grade, and the export has it.
  await teacher.goto(`/i/${slug}/courses/${course!.id}`);
  const row = teacher
    .getByTestId("course-matrix")
    .getByRole("row")
    .filter({ hasText: email("student") });
  await expect(row.getByRole("link")).toHaveText("55 ✓");
  const csv = await (await teacher.request.get(`/i/${slug}/courses/${course!.id}/grades.csv`)).text();
  const [header, line] = csv
    .replace(/^\ufeff/, "")
    .trim()
    .split("\r\n");
  const record = Object.fromEntries(header!.split(",").map((h, i) => [h, line!.split(",")[i]]));
  expect(record).toMatchObject({
    Email: email("student"),
    Assignment: "Todo API",
    Status: "graded",
    Tests: "50",
    Rubric: "80",
    Calculated: "50",
    Override: "55",
    Final: "55",
    Released: "yes",
  });

  // And the student's overview lists it.
  await student.goto(`/i/${slug}`);
  await expect(student.locator("section").filter({ hasText: "My assignments" }).getByText("grade 55")).toBeVisible();

  await studentCtx.close();
  await teacherCtx.close();
});
