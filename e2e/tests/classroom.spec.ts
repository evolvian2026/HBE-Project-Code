import { FakeGoogle } from "@hbe/lms/google-testing";
import { expect, test } from "@playwright/test";
import { createInstitutionWithAdmin, signIn, sql } from "./support.ts";

// The app under test points GOOGLE_FAKE_URL at this port (CI and the local E2E env file).
const GOOGLE_PORT = Number(process.env.E2E_FAKE_GOOGLE_PORT ?? 54390);
const suffix = Date.now().toString(36);
const email = (who: string) => `${who}-${suffix}@e2e.test`;
const slug = `gc-${suffix}`;
let google: FakeGoogle;

test.beforeAll(async () => {
  google = await FakeGoogle.serve(GOOGLE_PORT);
});
test.afterAll(async () => {
  await google.close();
  await sql("delete from public.institutions where slug = $1", [slug]);
  await sql("delete from auth.users where email like $1", [`%-${suffix}@e2e.test`]);
});

test("a teacher links a Google Classroom class, posts an assignment, and grades reach Classroom", async ({ page }) => {
  test.setTimeout(150_000);
  const institutionId = await createInstitutionWithAdmin(slug, `Classroom U ${suffix}`, email("admin"));
  await sql(
    "insert into public.lms_connections (institution_id, type, name) values ($1, 'google_classroom', 'Google Classroom')",
    [institutionId],
  );
  const [course] = await sql<{ id: string }>(
    "insert into public.courses (institution_id, code, name, term) values ($1, 'WD101', 'Web Development', '2026-T1') returning id",
    [institutionId],
  );
  await sql(
    `insert into public.invitations (institution_id, email, role, course_id, course_role) values
       ($1, $2, 'teacher', $3, 'instructor'), ($1, $4, 'student', null, null)`,
    [institutionId, email("teacher"), course!.id, email("student")],
  );
  const [assignment] = await sql<{ id: string }>(
    `insert into public.assignments (institution_id, course_id, slug, title, stack_profile_id, template_repo, due_at, status, published_at)
     values ($1, $2, 'todo-api', 'Todo API', (select id from public.stack_profiles where key = 'node22-api'), 't/t',
             now() + interval '7 days', 'published', now()) returning id`,
    [institutionId, course!.id],
  );
  google.addClass({
    id: `class-${suffix}`,
    name: "Web Dev",
    section: "Period 2",
    teacherSub: "g-teacher",
    students: [{ userId: "g-student", email: email("student"), name: "Grace Hopper" }],
  });

  // The student signs in once (accepting their invitation), so the roster can match them.
  await signIn(page, email("student"));
  await page.context().clearCookies();

  // The teacher connects Google from the course page.
  await signIn(page, email("teacher"));
  await page.goto(`/i/${slug}/courses/${course!.id}`);
  const card = page.locator("#classroom");
  google.signInAs = { sub: "g-teacher", email: email("teacher") };
  await card.getByRole("button", { name: "Connect Google Classroom" }).click();
  await expect(page.getByText("Your Google account is connected.")).toBeVisible();
  await expect(card.getByText(`Connected as ${email("teacher")}`)).toBeVisible();

  // Links their class: its students join the course.
  await card.getByLabel("Classroom class").selectOption({ label: "Web Dev (Period 2)" });
  await card.getByRole("button", { name: "Link class" }).click();
  await expect(card.getByTestId("classroom-classes")).toContainText("Web Dev (Period 2)");
  await expect(page.getByTestId("lms-roster")).toContainText("1 added to this course", { timeout: 30_000 });

  // Posts the assignment to Classroom.
  await page.goto(`/i/${slug}/courses/${course!.id}/assignments/${assignment!.id}`);
  const panel = page.locator("#lms");
  await panel.getByRole("button", { name: "Post to Google Classroom" }).click();
  await expect(panel.getByText("Posted to Google Classroom.")).toBeVisible();
  const work = [...google.courseWork.values()].find((w) => w.title === "Todo API");
  expect(work).toMatchObject({ maxPoints: 100, courseId: `class-${suffix}` });

  // A released grade goes to the student's Classroom submission.
  await sql("select private.ensure_submissions($1)", [assignment!.id]);
  await sql(
    `insert into public.grades (institution_id, submission_id, user_id, version, components, computed_score, final_score, complete, released_at)
     select s.institution_id, s.id, s.user_id, 1, '{}', 91, 91, true, now() from public.submissions s
     join public.profiles p on p.id = s.user_id where s.assignment_id = $1 and p.email = $2`,
    [assignment!.id, email("student")],
  );
  await page.reload();
  await panel.getByRole("button", { name: "Send all grades again" }).click();
  await expect(panel.getByTestId("lms-sync").getByText("sent", { exact: true })).toBeVisible({ timeout: 30_000 });
  expect(google.grades.at(-1)?.assignedGrade).toBe(91);
  expect([...google.submissions.values()].find((s) => s.userId === "g-student")?.state).toBe("RETURNED");
});
