import { CLAIM } from "@hbe/lms";
import { ROLES, TestPlatform, type ServedPlatform } from "@hbe/lms/testing";
import { expect, test } from "@playwright/test";
import { createInstitutionWithAdmin, sql } from "./support.ts";

const suffix = Date.now().toString(36);
const email = (who: string) => `${who}-${suffix}@e2e.test`;
const slug = `lmsg-${suffix}`;
const CLIENT_ID = `canvas-${suffix}`;
const context = { id: `course-${suffix}`, title: "Web Development (Canvas)" };
let lms: ServedPlatform;

test.beforeAll(async () => {
  lms = await TestPlatform.serve();
});
test.afterAll(async () => {
  await lms.close();
  await sql("delete from public.institutions where slug = $1", [slug]);
  await sql("delete from auth.users where email like $1", [`%-${suffix}@e2e.test`]);
});

test("an instructor adds an assignment from the LMS, and its grades go to the LMS gradebook", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(150_000);
  // The LMS checks the tool's signatures with the platform's published keys.
  lms.trustTool(new URL("/.well-known/jwks.json", baseURL).toString());
  const institutionId = await createInstitutionWithAdmin(slug, `LMS Grades U ${suffix}`, email("admin"));
  const [course] = await sql<{ id: string }>(
    "insert into public.courses (institution_id, code, name, term) values ($1, 'WD101', 'Web Development', '2026-T1') returning id",
    [institutionId],
  );
  await sql(
    `insert into public.invitations (institution_id, email, role, course_id, course_role) values ($1, $2, 'teacher', $3, 'instructor')`,
    [institutionId, email("teacher"), course!.id],
  );
  const [assignment] = await sql<{ id: string }>(
    `insert into public.assignments (institution_id, course_id, slug, title, stack_profile_id, template_repo, due_at, status, published_at)
     values ($1, $2, 'todo-api', 'Todo API', (select id from public.stack_profiles where key = 'node22-api'), 't/t',
             now() + interval '7 days', 'published', now()) returning id`,
    [institutionId, course!.id],
  );
  await sql(
    `insert into public.lms_connections (institution_id, type, name, issuer, client_id, auth_login_url, auth_token_url, jwks_url)
     values ($1, 'canvas', 'Canvas test', $2, $3, $4, $5, $6)`,
    [institutionId, lms.issuer, CLIENT_ID, lms.authUrl, lms.tokenUrl, lms.jwksUrl],
  );

  // In the LMS, the instructor adds external content: the platform's picker opens.
  lms.prepare({
    user: { sub: "canvas-teacher", email: email("teacher"), name: "Teacher", roles: [ROLES.instructor] },
    deploymentId: "1:abc",
    messageType: "LtiDeepLinkingRequest",
    context,
    services: true,
  });
  const teacher = await (await browser.newContext()).newPage();
  const login = new URL("/lti/login", baseURL);
  login.search = new URLSearchParams({
    iss: lms.issuer,
    login_hint: "canvas-teacher",
    target_link_uri: new URL("/lti/launch", baseURL).toString(),
    client_id: CLIENT_ID,
  }).toString();
  await teacher.goto(login.toString());
  await expect(
    teacher.getByRole("heading", { name: "Add HBE Projects assignments to Web Development (Canvas)" }),
  ).toBeVisible();
  await teacher.getByLabel(/Todo API/).check();
  await teacher.getByRole("button", { name: "Add to the LMS" }).click();
  await expect(teacher.getByRole("heading", { name: "Content added" })).toBeVisible();
  expect(lms.deepLinkResponses.at(-1)?.[CLAIM.deepLinkingContentItems]).toEqual([
    expect.objectContaining({ title: "Todo API", custom: { assignment_id: assignment!.id } }),
  ]);

  // A student of the (now linked) course has a released grade; the LMS knows them.
  const [student] = await sql<{ id: string }>(
    `insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
     values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $1, now(),
             '{"provider":"email","providers":["email"]}', '{"full_name":"Grace Hopper"}', now(), now()) returning id`,
    [email("student")],
  );
  await sql("insert into public.institution_memberships (institution_id, user_id, role) values ($1, $2, 'student')", [
    institutionId,
    student!.id,
  ]);
  await sql(
    "insert into public.course_memberships (institution_id, course_id, user_id, role) values ($1, $2, $3, 'student')",
    [institutionId, course!.id, student!.id],
  );
  await sql("select private.ensure_submissions($1)", [assignment!.id]);
  await sql(
    `insert into public.grades (institution_id, submission_id, user_id, version, components, computed_score, final_score, complete, released_at)
     select institution_id, id, user_id, 1, '{}', 82.5, 82.5, true, now() from public.submissions
     where assignment_id = $1 and user_id = $2`,
    [assignment!.id, student!.id],
  );
  await sql(
    `insert into public.lms_user_links (institution_id, lms_connection_id, lms_user_id, profile_id, status, matched_by)
     select $1, id, 'canvas-student', $2, 'linked', 'email' from public.lms_connections where client_id = $3`,
    [institutionId, student!.id, CLIENT_ID],
  );

  // The instructor opens the new link in the LMS: signed in, straight to the assignment.
  lms.prepare({
    user: { sub: "canvas-teacher", email: email("teacher"), name: "Teacher", roles: [ROLES.instructor] },
    deploymentId: "1:abc",
    context,
    services: true,
    custom: { assignment_id: assignment!.id },
  });
  await teacher.goto(login.toString());
  await expect(teacher).toHaveURL(new RegExp(`/courses/${course!.id}/assignments/${assignment!.id}$`));
  const panel = teacher.locator("#lms");
  await expect(
    panel.getByText("Released grades are sent to Web Development (Canvas) (Canvas test) automatically."),
  ).toBeVisible();
  await expect(panel.getByTestId("lms-sync")).toContainText("not sent yet");
  await panel.getByRole("button", { name: "Send all grades again" }).click();
  await expect(panel.getByTestId("lms-sync").getByText("sent", { exact: true })).toBeVisible({ timeout: 30_000 });
  expect(lms.scores.at(-1)?.score).toMatchObject({ userId: "canvas-student", scoreGiven: 82.5, scoreMaximum: 100 });
  // It went to the column the LMS made for the deep link (found by its resourceId).
  const columns = [...lms.lineItems.values()].filter((i) => i.resourceId === assignment!.id);
  expect(columns).toHaveLength(1);
  expect(lms.scores.at(-1)?.lineItemId).toBe(columns[0]!.id);
});
