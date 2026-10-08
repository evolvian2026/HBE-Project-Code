import { expect, test } from "@playwright/test";
import { passMfa, setUpMfa, signIn, sql } from "./support.ts";

const suffix = Date.now().toString(36);
const superEmail = `super-${suffix}@e2e.test`;
const adminEmail = `admin-${suffix}@e2e.test`;
const otherEmail = `other-${suffix}@e2e.test`;
const slug = `e2e-${suffix}`;
const name = `E2E University ${suffix}`;

test.afterAll(async () => {
  await sql("delete from public.institutions where slug like $1", [`%${suffix}`]);
  await sql("delete from auth.users where email like $1", [`%-${suffix}@e2e.test`]);
});

test("a super admin creates an institution and its invited admin lands in it", async ({ page, browser }) => {
  // A new account has no institutions.
  await signIn(page, superEmail);
  await expect(page.getByText("You are not a member of any institution yet")).toBeVisible();

  // Platform roles are granted out of band (there is no self-service path).
  await sql("insert into public.user_roles (user_id, role) select id, 'super_admin' from auth.users where email = $1", [
    superEmail,
  ]);
  // Super admins must set up two-factor authentication before the console opens.
  await page.goto("/platform");
  const superSecret = await setUpMfa(page);
  await expect(page.getByRole("heading", { name: "Platform console" })).toBeVisible();

  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Slug", { exact: true }).fill(slug);
  await page.getByLabel("First admin's email").fill(adminEmail);
  await page.getByRole("button", { name: "Create institution" }).click();
  await expect(page.getByText(`Institution “${slug}” created.`)).toBeVisible();
  const row = page.getByRole("row", { name: new RegExp(name) });
  await expect(row.getByText("invite pending")).toBeVisible();

  // The invited admin signs in (fresh browser) and the invitation is accepted on arrival.
  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  await signIn(admin, adminEmail);
  await setUpMfa(admin); // institution admins too
  await expect(admin).toHaveURL(new RegExp(`/i/${slug}$`));
  await expect(admin.getByRole("heading", { name })).toBeVisible();
  await expect(admin.getByText("You are")).toContainText("admin");
  await expect(admin.getByRole("button", { name: "Link your GitHub account" })).toBeVisible();

  // The platform console now counts the admin.
  await page.reload();
  await expect(row.getByRole("cell").nth(3)).toHaveText("1");

  // Admins can't see the platform console or other institutions.
  await admin.goto("/platform");
  await expect(admin.getByText("Page not found")).toBeVisible();
  await admin.goto("/i/not-their-institution");
  await expect(admin.getByText("Page not found")).toBeVisible();
  await adminContext.close();

  // Signing in again asks for a code instead of setting MFA up again.
  const again = await browser.newContext();
  const superAgain = await again.newPage();
  await signIn(superAgain, superEmail);
  await superAgain.goto("/platform");
  await passMfa(superAgain, superSecret);
  await expect(superAgain.getByRole("heading", { name: "Platform console" })).toBeVisible();
  await again.close();
});

test("someone without an invitation gets no access", async ({ page }) => {
  await signIn(page, otherEmail);
  await expect(page.getByText("You are not a member of any institution yet")).toBeVisible();
  await page.goto(`/i/${slug}`);
  await expect(page.getByText("Page not found")).toBeVisible();
});
