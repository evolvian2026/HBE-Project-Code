import { randomBytes, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createInstitutionWithAdmin, signIn, sql } from "./support.ts";

const suffix = Date.now().toString(36);
const email = (who: string) => `${who}-${suffix}@e2e.test`;
const slug = `stats-${suffix}`;
const DAY = 86_400_000;

test.afterAll(async () => {
  await sql("delete from public.institutions where slug = $1", [slug]);
  await sql("delete from auth.users where email like $1", [`%-${suffix}@e2e.test`]);
});

/** A student who never signs in (an account with a profile), in the institution. */
async function student(institutionId: string, name: string): Promise<string> {
  const id = randomUUID();
  await sql(
    `insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, now(),
             '{"provider":"email","providers":["email"]}', jsonb_build_object('full_name', $3::text), now(), now())`,
    [id, email(name.toLowerCase().replace(/\W/g, "")), name],
  );
  await sql("insert into public.institution_memberships (institution_id, user_id, role) values ($1, $2, 'student')", [
    institutionId,
    id,
  ]);
  return id;
}

async function course(institutionId: string, term: string) {
  const [c] = await sql<{ id: string }>(
    "insert into public.courses (institution_id, code, name, term) values ($1, 'WEB101', 'Web Development', $2) returning id",
    [institutionId, term],
  );
  const [a] = await sql<{ id: string }>(
    `insert into public.assignments (institution_id, course_id, slug, title, stack_profile_id, grader_suite_id, template_repo,
                                     due_at, status, published_at)
     values ($1, $2, 'todo-api', 'Todo API', (select id from public.stack_profiles where key = 'node22-api'),
             (select id from public.grader_suites where key = 'todo-api' and institution_id is null), 't/t',
             $3, 'published', $4) returning id`,
    [
      institutionId,
      c!.id,
      new Date(Date.now() + (term === "2026-T2" ? 3 : -100) * DAY),
      new Date(Date.now() - (term === "2026-T2" ? 10 : 120) * DAY),
    ],
  );
  return { courseId: c!.id, assignmentId: a!.id };
}

async function submission(
  institutionId: string,
  courseId: string,
  assignmentId: string,
  userId: string,
  status: string,
  finalized: boolean,
) {
  const [s] = await sql<{ id: string }>(
    `insert into public.submissions (institution_id, assignment_id, user_id, status, finalized_at)
     values ($1, $2, $3, $4, $5) returning id`,
    [institutionId, assignmentId, userId, status, finalized ? new Date() : null],
  );
  // In the course once the submission exists (joining a course creates missing ones).
  await sql(
    "insert into public.course_memberships (institution_id, course_id, user_id, role) values ($1, $2, $3, 'student')",
    [institutionId, courseId, userId],
  );
  return s!.id;
}

async function run(
  institutionId: string,
  submissionId: string,
  ago: number,
  score: number,
  results: [string, string][],
) {
  const [r] = await sql<{ id: string }>(
    `insert into public.evaluation_runs (institution_id, submission_id, sha, trigger, status, score, queued_at, started_at, finished_at)
     values ($1, $2, $3, 'push', 'completed', $4, $5, $5, $5) returning id`,
    [institutionId, submissionId, randomBytes(20).toString("hex"), score, new Date(Date.now() - ago)],
  );
  for (const [title, status] of results) {
    await sql(
      `insert into public.test_results (institution_id, run_id, stage, test_key, title, status)
       values ($1, $2, 'api', $3, $3, $4)`,
      [institutionId, r!.id, title, status],
    );
  }
}

test("staff see which tests students fail, who may need help, and how this term compares", async ({ page }) => {
  test.setTimeout(90_000);
  const institutionId = await createInstitutionWithAdmin(slug, `Stats U ${suffix}`, email("admin"));
  const now = await course(institutionId, "2026-T2");
  const before = await course(institutionId, "2026-T1");

  // This term: Ada is working (one test still failing); Grace's cutoff passed with nothing.
  const ada = await student(institutionId, "Ada Lovelace");
  const grace = await student(institutionId, "Grace Hopper");
  const adaSub = await submission(institutionId, now.courseId, now.assignmentId, ada, "active", false);
  await submission(institutionId, now.courseId, now.assignmentId, grace, "missing", true);
  await run(institutionId, adaSub, DAY, 0, [
    ["Creates a todo", "failed"],
    ["Rejects an empty title", "failed"],
  ]);
  await run(institutionId, adaSub, 60_000, 50, [
    ["Creates a todo", "passed"],
    ["Rejects an empty title", "failed"],
  ]);
  // Last term: five students.
  for (const [i, score] of [40, 60, 70, 80, 90].entries()) {
    const id = await student(institutionId, `Former ${i}`);
    const sub = await submission(institutionId, before.courseId, before.assignmentId, id, "graded", true);
    await run(institutionId, sub, 101 * DAY, score, [["Rejects an empty title", score < 70 ? "failed" : "passed"]]);
  }

  await sql(
    "insert into public.invitations (institution_id, email, role, course_id, course_role) values ($1, $2, 'teacher', $3, 'instructor')",
    [institutionId, email("teacher"), now.courseId],
  );
  await signIn(page, email("teacher"));
  await page.goto(`/i/${slug}/courses/${now.courseId}`);

  // Who may need help, and why.
  const atRisk = page.getByTestId("at-risk");
  await expect(atRisk.getByRole("listitem").filter({ hasText: "Grace Hopper" })).toContainText(
    "nothing submitted for 1 assignment (Todo API)",
  );
  // Ada's open work has signals too (her repository was never created here).
  await expect(atRisk.getByRole("listitem").filter({ hasText: "Ada Lovelace" })).toContainText(
    "Todo API: no repository yet",
  );

  // The assignment's analytics.
  await page.getByRole("link", { name: "Todo API" }).click();
  await page.getByRole("link", { name: "Analytics" }).click();
  await expect(page.getByRole("heading", { name: "Analytics" })).toBeVisible();
  const failing = page.getByRole("list", { name: "Share of submissions failing each test" });
  await expect(failing.getByRole("listitem").first()).toContainText("Rejects an empty title");
  await expect(failing.getByRole("listitem").first()).toContainText("100% (1)");
  await expect(page.getByRole("img", { name: /Failures of each test by day/ })).toBeVisible();
  const heat = page.locator("details", { hasText: "Show as a table" }).nth(1);
  await heat.getByText("Show as a table").click();
  await expect(heat.getByRole("row", { name: /Creates a todo/ })).toContainText("0/1");

  // This term against the last.
  await page.goto(`/i/${slug}/courses/${now.courseId}`);
  await page.getByRole("link", { name: "Compare with other terms" }).click();
  await expect(page.getByRole("heading", { name: "Compare terms" })).toBeVisible();
  const terms = page.getByRole("list", { name: "Median grade by term for Todo API" });
  await expect(terms.getByRole("listitem").filter({ hasText: "2026-T1" })).toContainText(
    "5 students · tests 70 · on time 100% · missing 0%",
  );
  await expect(terms.getByRole("listitem").filter({ hasText: "2026-T1" })).toContainText(
    "Most failed: Rejects an empty title (40%)",
  );
  await expect(terms.getByRole("listitem").filter({ hasText: "this term" })).toContainText("too few to show");
});
