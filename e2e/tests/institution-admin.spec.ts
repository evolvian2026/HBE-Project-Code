import { expect, test, type Page } from "@playwright/test";
import { createInstitutionWithAdmin, setUpMfa, signIn, sql } from "./support.ts";

const suffix = Date.now().toString(36);
const email = (who: string) => `${who}-${suffix}@e2e.test`;
const slug = `admin-${suffix}`;
const name = `Admin Test College ${suffix}`;
const tab = (page: Page, label: string) =>
  page.getByRole("navigation", { name: "Institution" }).getByRole("link", { name: label, exact: true });

test.afterAll(async () => {
  await sql("delete from public.institutions where slug = $1", [slug]);
  await sql("delete from auth.users where email like $1", [`%-${suffix}@e2e.test`]);
});

test("an admin sets up a course, invites people, and each role sees the right things", async ({ browser }) => {
  await createInstitutionWithAdmin(slug, name, email("admin"));

  const adminCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  await signIn(admin, email("admin"));
  await setUpMfa(admin);
  await expect(admin).toHaveURL(new RegExp(`/i/${slug}$`));

  // Create a course.
  await tab(admin, "Courses").click();
  await admin.getByLabel("Code").fill("CS101");
  await admin.getByLabel("Name", { exact: true }).fill("Web Development");
  await admin.getByLabel("Term").fill("2026-T1");
  await admin.getByRole("button", { name: "Create course" }).click();
  await expect(admin.getByRole("heading", { name: "CS101 · Web Development" })).toBeVisible();
  await expect(admin.getByText("Instructors (1)")).toBeVisible(); // the creator

  // Invite a teacher into the course from the course page.
  await admin.getByLabel("Email or GitHub username").fill(email("teacher"));
  await admin.locator("select[name=role]").selectOption("teacher");
  await admin.getByRole("button", { name: "Send invitation" }).click();
  await expect(admin.getByText("Done: 1 invited.")).toBeVisible();

  // Import students by CSV, including a duplicate and a bad row.
  await tab(admin, "Members").click();
  const csv = [
    "email,role,course_code,course_role",
    `${email("student1")},student,CS101,student`,
    `${email("student2")},student,CS101,`,
    `${email("student2")},student,CS101,`,
    `not-an-email,student,CS101,`,
  ].join("\n");
  await admin
    .getByLabel("CSV file")
    .setInputFiles({ name: "class.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await admin.getByRole("button", { name: "Import" }).click();
  await expect(admin.getByText("Done: 2 invited, 1 skipped, 1 with errors.")).toBeVisible();
  await expect(admin.getByText(/Line 5: not-an-email: is not a valid email address/)).toBeVisible();
  await expect(admin.getByText("3 waiting")).toBeVisible();

  // Invitation emails were queued.
  const [queued] = await sql<{ count: string }>(
    "select count(*) from public.email_outbox where template = 'invitation' and to_email like $1",
    [`%-${suffix}@e2e.test`],
  );
  expect(Number(queued!.count)).toBe(4); // admin + teacher + 2 students

  // The last admin cannot demote themselves.
  const me = admin.getByRole("listitem").filter({ hasText: "(you)" });
  await me.locator("select[name=role]").selectOption("teacher");
  await me.getByRole("button", { name: "Save" }).click();
  await expect(me.getByText("An institution must keep at least one active admin")).toBeVisible();

  // The teacher signs in and sees the course and its people.
  const teacherCtx = await browser.newContext();
  const teacher = await teacherCtx.newPage();
  await signIn(teacher, email("teacher"));
  await expect(teacher).toHaveURL(new RegExp(`/i/${slug}$`));
  await teacher.getByRole("link", { name: "CS101 · Web Development" }).click();
  await expect(teacher.getByText("Instructors (2)")).toBeVisible();
  await expect(tab(teacher, "Members")).toBeVisible();

  // A student sees only their course, without people lists or the Members tab.
  const studentCtx = await browser.newContext();
  const student = await studentCtx.newPage();
  await signIn(student, email("student1"));
  await expect(tab(student, "My courses")).toBeVisible();
  await expect(tab(student, "Members")).toHaveCount(0);
  await student.getByRole("link", { name: "CS101 · Web Development" }).first().click();
  await expect(student.getByRole("heading", { name: "CS101 · Web Development" })).toBeVisible();
  await expect(student.getByText("Instructors (2)")).toHaveCount(0);
  await student.goto(`/i/${slug}/members`);
  await expect(student.getByText("Page not found")).toBeVisible();

  for (const ctx of [adminCtx, teacherCtx, studentCtx]) await ctx.close();
});
