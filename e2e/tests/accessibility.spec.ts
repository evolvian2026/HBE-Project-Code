import { randomBytes } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { createInstitutionWithAdmin, setUpMfa, signIn, sql } from "./support.ts";

/**
 * WCAG 2.1 AA (NFR-10), checked with axe on the pages each role uses, with real data on them:
 * a published assignment, a student's repository with commits, a finished test run, a released
 * grade with feedback and a code comment. Every violation on every page is reported at once.
 * The same pages must load without breaking the Content-Security-Policy.
 */
const suffix = Date.now().toString(36);
const email = (who: string) => `${who}-${suffix}@e2e.test`;
const slug = `a11y-${suffix}`;

test.afterAll(async () => {
  await sql("delete from public.institutions where slug = $1", [slug]);
  await sql("delete from auth.users where email like $1", [`%-${suffix}@e2e.test`]);
  await sql("delete from public.github_installations where account_login = $1", [`org-${suffix}`]);
});

const problems: string[] = [];

const watched = new WeakSet<Page>();

/** Audits the page in the light and the dark colour scheme (and notes any CSP violation). */
async function audit(page: Page, path: string) {
  if (!watched.has(page)) {
    watched.add(page);
    page.on("console", (m) => {
      if (m.type() === "error" && /Content Security Policy/i.test(m.text())) {
        problems.push(`${page.url()} — CSP violation: ${m.text()}`);
      }
    });
  }
  await page.goto(path);
  await page.waitForLoadState("networkidle");
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    const { violations } = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    for (const v of violations) {
      const where = v.nodes
        .slice(0, 3)
        .map((n) => n.target.join(" "))
        .join(" | ");
      problems.push(`${path} (${colorScheme}) — [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length}×: ${where})`);
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
}

test("the main pages meet WCAG 2.1 AA for every role", async ({ browser }) => {
  test.setTimeout(240_000);
  const institutionId = await createInstitutionWithAdmin(slug, `Access U ${suffix}`, email("admin"));
  const [gh] = await sql<{ id: string }>(
    "insert into public.github_installations (institution_id, installation_id, account_id, account_login, account_type) values ($1, $2, 1, $3, 'Organization') returning id",
    [institutionId, Math.floor(Math.random() * 1e9), `org-${suffix}`],
  );
  const [course] = await sql<{ id: string }>(
    "insert into public.courses (institution_id, code, name, term, github_installation_id) values ($1, 'WEB101', 'Web Development', '2026-T1', $2) returning id",
    [institutionId, gh!.id],
  );
  await sql(
    `insert into public.invitations (institution_id, email, role, course_id, course_role) values
       ($1, $2, 'student', $3, 'student'), ($1, $4, 'teacher', $3, 'instructor')`,
    [institutionId, email("student"), course!.id, email("teacher")],
  );

  // Everyone signs in (the student links GitHub, simulated).
  const admin = await (await browser.newContext()).newPage();
  await signIn(admin, email("admin"));
  await setUpMfa(admin);
  const teacher = await (await browser.newContext()).newPage();
  await signIn(teacher, email("teacher"));
  const student = await (await browser.newContext()).newPage();
  await signIn(student, email("student"));
  const [ada] = await sql<{ id: string }>("select id from auth.users where email = $1", [email("student")]);
  await sql(
    `insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at, last_sign_in_at)
     values ($1, $2, '{"user_name":"ada-dev"}'::jsonb, 'github', now(), now(), now())`,
    [String(Math.floor(Math.random() * 1e9)), ada!.id],
  );

  // A graded, released submission with a test run, commits, feedback and a code comment.
  const head = randomBytes(20).toString("hex");
  const [assignment] = await sql<{ id: string }>(
    `insert into public.assignments (institution_id, course_id, slug, title, spec_md, stack_profile_id, grader_suite_id, template_repo,
                                     due_at, status, published_at)
     values ($1, $2, 'todo-api', 'Todo API', E'# Todo API\\n\\nBuild a REST API for todos.\\n\\n- \`GET /todos\`\\n- \`POST /todos\`',
             (select id from public.stack_profiles where key = 'node22-api'),
             (select id from public.grader_suites where key = 'todo-api' and institution_id is null), 't/t',
             now() - interval '1 day', 'published', now() - interval '10 days')
     returning id`,
    [institutionId, course!.id],
  );
  await sql(
    "insert into public.assignment_criteria (institution_id, assignment_id, title, max_points) values ($1, $2, 'Code quality', 10)",
    [institutionId, assignment!.id],
  );
  const [repo] = await sql<{ id: string }>(
    "insert into public.repositories (institution_id, github_installation_id, owner, name, github_repo_id, head_sha) values ($1, $2, $3, 'todo-api-ada', $4, $5) returning id",
    [institutionId, gh!.id, `org-${suffix}`, Math.floor(Math.random() * 1e9), head],
  );
  const [submission] = await sql<{ id: string }>(
    `insert into public.submissions (institution_id, assignment_id, user_id, repository_id, status, final_sha, submitted_at,
                                     finalized_at, late_days, grade_released_at)
     values ($1, $2, $3, $4, 'graded', $5, now() - interval '2 days', now() - interval '1 day', 0, now()) returning id`,
    [institutionId, assignment!.id, ada!.id, repo!.id, head],
  );
  await sql(
    `insert into public.commits (institution_id, repository_id, sha, message, authored_at, author_login, author_profile_id,
                                 details_status, parent_count, effective_lines, attribution)
     values ($1, $2, $3, 'Add todo routes', now() - interval '3 days', 'ada-dev', $4, 'done', 1, 40, 'github')`,
    [institutionId, repo!.id, head, ada!.id],
  );
  const [run] = await sql<{ id: string }>(
    `insert into public.evaluation_runs (institution_id, submission_id, sha, trigger, status, score, summary, queued_at, started_at, finished_at)
     values ($1, $2, $3, 'deadline', 'completed', 75,
             '{"stages": [{"key": "api", "status": "failed", "duration_ms": 1200}], "passed": 3, "total": 4, "score": 75}',
             now() - interval '1 day', now() - interval '1 day', now() - interval '1 day') returning id`,
    [institutionId, submission!.id, head],
  );
  await sql(
    `insert into public.test_results (institution_id, run_id, stage, test_key, title, status, expected, actual, hint) values
       ($1, $2, 'api', 'todos.create', 'Creates a todo', 'passed', null, null, null),
       ($1, $2, 'api', 'todos.validate', 'Rejects an empty title', 'failed', '400', '201', 'Check the title before saving.')`,
    [institutionId, run!.id],
  );
  await sql(
    `insert into public.process_snapshots (institution_id, submission_id, score, breakdown, policy, is_final)
     values ($1, $2, 80, $3, '{}', true)`,
    [
      institutionId,
      submission!.id,
      JSON.stringify({
        score: 80,
        criteria: [
          {
            key: "active_days",
            label: "Active days",
            weight: 60,
            earned: 1,
            points: 60,
            explanation: "Active on 6 of 6 target days.",
          },
          {
            key: "issue_tracking",
            label: "Issue tracking",
            weight: 40,
            earned: 0.5,
            points: 20,
            explanation: "1 of 2 issues opened and closed.",
          },
        ],
        meaningfulCommits: 1,
        creditedCommits: 1,
        unattributedCommits: 0,
        pendingCommits: 0,
      }),
    ],
  );
  await sql(
    `insert into public.grades (institution_id, submission_id, user_id, version, components, computed_score, final_score, complete, released_at)
     values ($1, $2, $3, 1, $4, 77, 77, true, now())`,
    [
      institutionId,
      submission!.id,
      ada!.id,
      JSON.stringify({
        automated: { weight: 60, score: 75, points: 45, runId: run!.id },
        rubric: { weight: 25, score: 80, points: 20, points_awarded: 8, max_points: 10 },
        process: { weight: 15, score: 80, points: 12 },
        pending: [],
        raw: 77,
      }),
    ],
  );
  await sql(
    "insert into public.feedback (institution_id, submission_id, body_md) values ($1, $2, 'Good structure. Validate input.')",
    [institutionId, submission!.id],
  );
  await sql(
    "insert into public.review_comments (institution_id, submission_id, sha, path, line, body) values ($1, $2, $3, 'src/server.js', 3, 'Validate the title here')",
    [institutionId, submission!.id, head],
  );

  const base = `/i/${slug}`;
  const courseUrl = `${base}/courses/${course!.id}`;
  const assignmentUrl = `${courseUrl}/assignments/${assignment!.id}`;
  const submissionUrl = `${assignmentUrl}/submissions/${submission!.id}`;

  // Signed out.
  const anonymous = await (await browser.newContext()).newPage();
  await audit(anonymous, "/login");

  // Student.
  for (const path of [
    base,
    `${base}/courses`,
    courseUrl,
    assignmentUrl,
    submissionUrl,
    `${submissionUrl}/runs/${run!.id}`,
    `${base}/grades`,
    `${base}/notifications`,
    "/account/security",
    "/account/notifications",
    "/account/data",
  ]) {
    await audit(student, path);
  }

  // Keyboard users can skip the header straight to the page.
  await student.goto(base);
  await student.keyboard.press("Tab");
  const skip = student.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();
  await student.keyboard.press("Enter");
  await expect(student.locator("main")).toBeFocused();

  // Teacher.
  for (const path of [
    courseUrl,
    assignmentUrl,
    `${assignmentUrl}/edit`,
    `${assignmentUrl}/analytics`,
    `${assignmentUrl}/similarity`,
    `${courseUrl}/cohorts`,
    submissionUrl,
    `${base}/students/${ada!.id}`,
  ]) {
    await audit(teacher, path);
  }

  // Institution admin.
  for (const path of [
    `${base}/members`,
    `${base}/lms`,
    `${base}/records`,
    `${base}/stacks`,
    `${base}/audit`,
    `${base}/settings`,
    `${courseUrl}/assignments/new`,
  ]) {
    await audit(admin, path);
  }

  // Platform operator.
  const operator = await (await browser.newContext()).newPage();
  await signIn(operator, email("operator"));
  await sql("insert into public.user_roles (user_id, role) select id, 'super_admin' from auth.users where email = $1", [
    email("operator"),
  ]);
  await operator.goto("/platform");
  await setUpMfa(operator);
  for (const path of ["/platform", "/platform/health", "/platform/audit", "/platform/domains"])
    await audit(operator, path);

  expect(problems, problems.join("\n")).toEqual([]);
});
