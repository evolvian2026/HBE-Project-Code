import { ROLES, TestPlatform, type ServedPlatform } from "@hbe/lms/testing";
import { expect, test, type Page } from "@playwright/test";
import { createInstitutionWithAdmin, setUpMfa, signIn, sql } from "./support.ts";

const suffix = Date.now().toString(36);
const email = (who: string) => `${who}-${suffix}@e2e.test`;
const slug = `lti-${suffix}`;
const CLIENT_ID = `canvas-${suffix}`;
const context = { id: `course-${suffix}`, title: "Web Development (Canvas)" };
let platform: ServedPlatform;

test.beforeAll(async () => {
  platform = await TestPlatform.serve();
});
test.afterAll(async () => {
  await platform.close();
  await sql("delete from public.institutions where slug = $1", [slug]);
  await sql("delete from auth.users where email like $1", [`%-${suffix}@e2e.test`]);
});

/** Opens the activity "in the LMS": the platform's login initiation, auth response and launch. */
async function launchAs(page: Page, baseURL: string, user: { who: string; roles: string[] }) {
  platform.prepare({
    user: { sub: `canvas-${user.who}`, email: email(user.who), name: `${user.who} ${suffix}`, roles: user.roles },
    deploymentId: "1:abc",
    context,
  });
  const login = new URL("/lti/login", baseURL);
  login.search = new URLSearchParams({
    iss: platform.issuer,
    login_hint: `canvas-${user.who}`,
    target_link_uri: new URL("/lti/launch", baseURL).toString(),
    client_id: CLIENT_ID,
  }).toString();
  await page.goto(login.toString());
}

test("people open the platform from their LMS and land in the linked course", async ({ browser, baseURL }) => {
  test.setTimeout(150_000);
  const institutionId = await createInstitutionWithAdmin(slug, `LTI U ${suffix}`, email("admin"));
  const [course] = await sql<{ id: string }>(
    "insert into public.courses (institution_id, code, name, term) values ($1, 'WD101', 'Web Development', '2026-T1') returning id",
    [institutionId],
  );
  // Invited but never signed in: the launch creates their accounts.
  await sql(
    `insert into public.invitations (institution_id, email, role, course_id, course_role) values
       ($1, $2, 'teacher', $3, 'instructor'), ($1, $4, 'student', null, null)`,
    [institutionId, email("teacher"), course!.id, email("student")],
  );
  await sql(
    `insert into public.lms_connections (institution_id, type, name, issuer, client_id, auth_login_url, auth_token_url, jwks_url)
     values ($1, 'canvas', 'Canvas test', $2, $3, $4, $5, $6)`,
    [institutionId, platform.issuer, CLIENT_ID, platform.authUrl, `${platform.issuer}/token`, platform.jwksUrl],
  );

  // The instructor's first launch: they're signed in and asked which course this is.
  const teacher = await (await browser.newContext()).newPage();
  await launchAs(teacher, baseURL!, { who: "teacher", roles: [ROLES.instructor] });
  await expect(teacher).toHaveURL(/\/lti\/link-course\//);
  await expect(teacher.getByRole("heading", { name: "Link “Web Development (Canvas)”" })).toBeVisible();
  await teacher.getByLabel(/WD101 Web Development/).check();
  await teacher.getByRole("button", { name: "Link course" }).click();
  await expect(teacher).toHaveURL(new RegExp(`/i/${slug}/courses/${course!.id}`));
  await expect(teacher.getByTestId("lms-linked")).toContainText("Web Development (Canvas) (Canvas test)");

  // A student launching from the same LMS course lands in it and joins it.
  const student = await (await browser.newContext()).newPage();
  await launchAs(student, baseURL!, { who: "student", roles: [ROLES.learner] });
  await expect(student).toHaveURL(new RegExp(`/i/${slug}/courses/${course!.id}$`));
  await expect(student.getByRole("heading", { name: "WD101 · Web Development" })).toBeVisible();
  const [membership] = await sql<{ source: string }>(
    "select source from public.course_memberships m join public.profiles p on p.id = m.user_id where p.email = $1",
    [email("student")],
  );
  expect(membership?.source).toBe("lms");

  // Someone the platform doesn't know waits for an admin.
  const stranger = await (await browser.newContext()).newPage();
  await launchAs(stranger, baseURL!, { who: "stranger", roles: [ROLES.learner] });
  await expect(stranger).toHaveURL(/\/lti\/pending\?/);
  await expect(stranger.getByText(`LTI U ${suffix}'s admin has been asked to link it`)).toBeVisible();

  // The admin sees the connection, the linked course and the person waiting, and refuses them.
  const admin = await (await browser.newContext()).newPage();
  await signIn(admin, email("admin"));
  await setUpMfa(admin);
  await admin.getByRole("navigation", { name: "Institution" }).getByRole("link", { name: "LMS" }).click();
  await expect(admin.getByTestId("lms-connections")).toContainText("Canvas test");
  await expect(admin.getByTestId("lms-courses")).toContainText("WD101 Web Development");
  const waiting = admin.getByTestId("lms-waiting");
  await expect(waiting).toContainText(email("stranger"));
  await waiting.getByRole("button", { name: "Refuse" }).click();
  await expect(admin.getByText("Their launches will be refused.")).toBeVisible();

  // And makes a one-time registration URL for another LMS.
  await admin.getByLabel("Name").first().fill("Moodle");
  await admin.getByLabel("LMS").first().selectOption("moodle");
  await admin.getByRole("button", { name: "Create a registration URL" }).click();
  await expect(admin.getByLabel("Registration URL")).toHaveValue(/\/lti\/register\?invite=/);
});
