import { expect, test } from "@playwright/test";
import { createInstitutionWithAdmin, setUpMfa, signIn, sql } from "./support.ts";

const suffix = Date.now().toString(36);
const email = (who: string) => `${who}-${suffix}@e2e.test`;
const slug = `erase-${suffix}`;

test.afterAll(async () => {
  await sql("delete from public.institutions where slug = $1", [slug]);
  await sql("delete from auth.users where email like $1", [`%-${suffix}@e2e.test`]);
  await sql(
    "delete from auth.users where raw_app_meta_data ->> 'provider' = 'erased' and id not in (select user_id from public.institution_memberships)",
  );
});

test("a student asks for their data to be erased; an admin anonymises it, and erases another member's outright", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const institutionId = await createInstitutionWithAdmin(slug, `Erase U ${suffix}`, email("admin"));
  const [course] = await sql<{ id: string }>(
    "insert into public.courses (institution_id, code, name, term) values ($1, 'PRIV1', 'Privacy', '2026-T1') returning id",
    [institutionId],
  );
  await sql(
    `insert into public.invitations (institution_id, email, role, course_id, course_role) values
       ($1, $2, 'student', $3, 'student'), ($1, $4, 'student', $3, 'student')`,
    [institutionId, email("ada"), course!.id, email("linus")],
  );

  const admin = await (await browser.newContext()).newPage();
  await signIn(admin, email("admin"));
  await setUpMfa(admin);

  // Ada asks, from her account.
  const ada = await (await browser.newContext()).newPage();
  await signIn(ada, email("ada"));
  const linus = await (await browser.newContext()).newPage();
  await signIn(linus, email("linus"));
  await ada.goto("/account/data");
  await ada.getByText(`Ask Erase U ${suffix} to erase my data…`).click();
  await ada.getByLabel("Anything they should know (optional)").fill("I've left the course.");
  await ada.getByRole("button", { name: "Send the request" }).click();
  // The form gives way to the request's status.
  await expect(ada.getByText("waiting for the admins")).toBeVisible();

  // The admins are told; one anonymises her.
  await admin.goto(`/i/${slug}/notifications`);
  await expect(admin.getByText("Someone asked for their personal data to be erased")).toBeVisible();
  await admin.goto(`/i/${slug}/members`);
  const requests = admin.getByTestId("erasure-requests");
  await expect(requests).toContainText("waiting for a decision");
  await expect(requests).toContainText("I've left the course.");
  await requests.getByRole("button", { name: "Erase their data" }).click();
  // The decision gives way to the erasure's progress, and the worker finishes it.
  await expect(async () => {
    await admin.reload();
    await expect(requests).toContainText("anonymised", { timeout: 1000 });
  }).toPass({ timeout: 30_000 });
  await expect(requests).toContainText(/Erased student [0-9A-F]{6}/);
  await expect(requests).toContainText("Their account was deleted.");
  const members = admin.getByRole("listitem").filter({ hasText: "personal data erased" });
  await expect(members).toHaveCount(1);
  await expect(admin.getByText(email("ada"))).toHaveCount(0);
  const [gone] = await sql<{ n: number }>("select count(*)::int as n from auth.users where email = $1", [email("ada")]);
  expect(gone!.n).toBe(0);

  // The admin erases Linus's data outright, confirming first.
  const row = admin.getByRole("listitem").filter({ hasText: email("linus") });
  await row.getByText("Erase personal data…").click();
  const form = admin.getByRole("form", { name: `Erase ${email("linus")}'s personal data` });
  await form.getByLabel("Delete").check();
  await form.getByRole("button", { name: "Erase personal data" }).click();
  // Nothing happens until ERASE is typed (the browser checks it before sending).
  const confirm = form.getByLabel("Type ERASE to confirm");
  await confirm.fill("yes");
  await form.getByRole("button", { name: "Erase personal data" }).click();
  expect(await confirm.evaluate((el: HTMLInputElement) => el.validity.patternMismatch)).toBe(true);
  await expect(form.getByLabel("Delete")).toBeChecked();
  await form.getByLabel("Type ERASE to confirm").fill("ERASE");
  await form.getByRole("button", { name: "Erase personal data" }).click();
  await expect(admin.getByText("Erasing their personal data. It's listed under Erasure requests.")).toBeVisible();
  await expect(async () => {
    await admin.reload();
    await expect(admin.getByRole("listitem").filter({ hasText: "personal data erased" })).toHaveCount(2, {
      timeout: 1000,
    });
  }).toPass({ timeout: 30_000 });
  await expect(requests.getByText("deleted", { exact: true })).toBeVisible();
  await expect(requests).not.toContainText("erasing");

  // The audit log records each erasure, without naming them.
  await admin.goto(`/i/${slug}/audit?entity=personal_data`);
  await expect(admin.getByTestId("audit-rows").getByText("Personal data erasure", { exact: false })).toHaveCount(2);
  await expect(admin.getByTestId("audit-rows")).not.toContainText(email("ada"));
});
