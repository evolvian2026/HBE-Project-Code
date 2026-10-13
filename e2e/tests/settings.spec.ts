import { expect, test } from "@playwright/test";
import { createInstitutionWithAdmin, setUpMfa, signIn, sql } from "./support.ts";

const suffix = Date.now().toString(36);
const email = (who: string) => `${who}-${suffix}@e2e.test`;
const slug = `set-${suffix}`;
const name = `Settings U ${suffix}`;

test.afterAll(async () => {
  await sql("update public.platform_settings set value = '\"\"' where key = 'maintenance_banner'");
  await sql("delete from public.institutions where slug = $1", [slug]);
  await sql("delete from auth.users where email like $1", [`%-${suffix}@e2e.test`]);
});

test("the operator sets limits, a notice and test suites; the admin chooses assignment defaults and stacks", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const institutionId = await createInstitutionWithAdmin(slug, name, email("admin"));
  const [course] = await sql<{ id: string }>(
    "insert into public.courses (institution_id, code, name, term) values ($1, 'CS200', 'Systems', '2026-T1') returning id",
    [institutionId],
  );

  // The operator allows 1 student, and announces maintenance.
  const operator = await (await browser.newContext()).newPage();
  await signIn(operator, email("operator"));
  await sql("insert into public.user_roles (user_id, role) select id, 'super_admin' from auth.users where email = $1", [
    email("operator"),
  ]);
  await operator.goto("/platform");
  await setUpMfa(operator);
  const row = operator.getByRole("row", { name: new RegExp(name) });
  await row.locator("summary", { hasText: "Limits" }).click();
  const limits = row.getByRole("form", { name: `Limits for ${name}` });
  await limits.getByLabel("Active students").fill("1");
  await limits.getByRole("button", { name: "Save limits" }).click();
  await expect(operator.getByText("Limits saved.")).toBeVisible();
  await operator.getByLabel("Notice").fill(`Maintenance tonight ${suffix}`);
  await operator.getByRole("button", { name: "Save notice" }).click();
  await expect(operator.getByText("Notice shown.")).toBeVisible();

  // The admin sees the notice and the limit, and sets what new assignments start with.
  const admin = await (await browser.newContext()).newPage();
  await signIn(admin, email("admin"));
  await setUpMfa(admin);
  await expect(admin.getByTestId("maintenance-banner")).toHaveText(`Maintenance tonight ${suffix}`);
  await admin.getByRole("navigation", { name: "Institution" }).getByRole("link", { name: "Settings" }).click();
  await expect(admin.getByTestId("limits")).toContainText("0 active of 1");
  await admin.getByLabel("Test runs per student per day").fill("3");
  await admin.getByLabel("Automated tests (%)").fill("50");
  await admin.getByLabel("Rubric (%)").fill("30");
  await admin.getByLabel("Process (%)").fill("20");
  await admin.getByLabel("Post released feedback and code comments to GitHub").check();
  await admin.getByRole("button", { name: "Save settings" }).click();
  await expect(admin.getByText("Settings saved.")).toBeVisible();

  // Stacks: the admin adds their own stack profile and stops offering Django; the operator
  // registers a test suite for the institution.
  await admin.getByRole("navigation", { name: "Institution" }).getByRole("link", { name: "Stacks" }).click();
  await admin.getByLabel("Offer Django REST + React (Python 3.12, PostgreSQL) v1").uncheck();
  await admin.getByRole("button", { name: "Save choice" }).click();
  await expect(admin.getByText("Saved.")).toBeVisible();
  await admin.getByLabel("Key").fill(`spring-${suffix}`);
  await admin.getByLabel("Name", { exact: true }).fill(`Spring Boot ${suffix}`);
  await admin.getByRole("button", { name: "Add stack profile" }).click();
  await expect(admin.getByText(`Added spring-${suffix} v1.`)).toBeVisible();
  await operator.reload();
  const suiteForm = operator.locator("form", { hasText: "Folder in the grader repository" });
  await suiteForm.getByLabel("For").selectOption({ label: name });
  await suiteForm.getByLabel("Suite key").fill(`shop-${suffix}`);
  await suiteForm.getByLabel("Title").fill(`Shop API ${suffix}`);
  await suiteForm.getByLabel("Folder in the grader repository").fill("suites/acme/shop");
  await suiteForm.getByRole("button", { name: "Register suite" }).click();
  await expect(operator.getByText(`Test suite shop-${suffix} v1 registered.`)).toBeVisible();
  await admin.reload();
  await expect(admin.getByTestId("suites")).toContainText(`Shop API ${suffix}`);

  await admin.goto(`/i/${slug}/courses/${course!.id}/assignments/new`);
  await expect(admin.getByLabel("Test runs per student per day")).toHaveValue("3");
  await expect(admin.getByLabel("Also post the feedback and code comments to GitHub")).toBeChecked();
  const stack = admin.getByLabel("Stack profile");
  await expect(stack.locator("option", { hasText: `Spring Boot ${suffix}` })).toHaveCount(1);
  await expect(stack.locator("option", { hasText: "Django REST" })).toHaveCount(0);
  await expect(stack.locator("option", { hasText: "MERN" })).toHaveCount(1);
  await expect(admin.getByLabel("Hidden test suite").locator("option", { hasText: `Shop API ${suffix}` })).toHaveCount(
    1,
  );

  // Inviting past the limit is refused, with the reason.
  await admin.goto(`/i/${slug}/members`);
  const invite = async (who: string) => {
    await admin.getByLabel("Email or GitHub username").fill(email(who));
    await admin.getByRole("button", { name: "Send invitation" }).click();
  };
  await invite("ada");
  await expect(admin.getByText("Done: 1 invited.")).toBeVisible();
  await invite("grace");
  await expect(
    admin.getByText("This institution has reached its limit of 1 students.", { exact: false }),
  ).toBeVisible();

  // Each change is in the audit log: the institution's for its admin, filtered and exported.
  await admin.goto(`/i/${slug}/audit`);
  const log = admin.getByTestId("audit-rows");
  await expect(log.getByText("Institution changed").first()).toBeVisible();
  await admin.getByLabel("What").selectOption("stack_profiles");
  await admin.getByRole("button", { name: "Filter" }).click();
  await expect(admin).toHaveURL(/entity=stack_profiles/);
  await expect(log.getByText("Stack profile added")).toHaveCount(1);
  await expect(log.getByText("Institution changed")).toHaveCount(0);
  await log.getByText("Stack profile added").click();
  await expect(log).toContainText(`spring-${suffix}`);
  const csv = await admin.request.get(`/i/${slug}/audit/export?entity=stack_profiles`);
  expect(csv.headers()["content-type"]).toContain("text/csv");
  const text = await csv.text();
  expect(text).toContain("stack_profiles");
  expect(text).toContain(`spring-${suffix}`);
  expect(text).toContain(email("admin"));
  // The platform's own changes are the operator's.
  await operator.goto("/platform/audit?entity=platform_settings");
  await expect(operator.getByTestId("audit-rows").getByText("Platform setting changed").first()).toBeVisible();
  await expect(operator.getByTestId("audit-rows")).toContainText(email("operator"));

  // The operator removes the notice.
  await operator.goto("/platform");
  await operator.getByLabel("Notice").fill("");
  await operator.getByRole("button", { name: "Save notice" }).click();
  await expect(operator.getByText("Notice removed.")).toBeVisible();
  await admin.reload();
  await expect(admin.getByTestId("maintenance-banner")).toHaveCount(0);
});
