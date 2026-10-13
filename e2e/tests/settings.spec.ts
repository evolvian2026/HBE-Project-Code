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

test("the operator sets an institution's limits and a notice; its admin chooses assignment defaults", async ({
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

  await admin.goto(`/i/${slug}/courses/${course!.id}/assignments/new`);
  await expect(admin.getByLabel("Test runs per student per day")).toHaveValue("3");
  await expect(admin.getByLabel("Also post the feedback and code comments to GitHub")).toBeChecked();

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

  // The operator removes the notice.
  await operator.getByLabel("Notice").fill("");
  await operator.getByRole("button", { name: "Save notice" }).click();
  await expect(operator.getByText("Notice removed.")).toBeVisible();
  await admin.reload();
  await expect(admin.getByTestId("maintenance-banner")).toHaveCount(0);
});
