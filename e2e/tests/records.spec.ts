import { expect, test } from "@playwright/test";
import { createInstitutionWithAdmin, setUpMfa, signIn, sql } from "./support.ts";

const suffix = Date.now().toString(36);
const email = (who: string) => `${who}-${suffix}@e2e.test`;
const slug = `records-${suffix}`;

test.afterAll(async () => {
  await sql("delete from public.institutions where slug = $1", [slug]);
  await sql("delete from auth.users where email like $1", [`%-${suffix}@e2e.test`]);
});

test("an admin exports the institution's records and ends the contract", async ({ page }) => {
  test.setTimeout(120_000);
  const institutionId = await createInstitutionWithAdmin(slug, `Records U ${suffix}`, email("admin"));
  // A course with one assignment and a student, so the export has a grades.csv row.
  const [course] = await sql<{ id: string }>(
    "insert into public.courses (institution_id, code, name, term) values ($1, 'RC100', 'Records', '2026-T1') returning id",
    [institutionId],
  );
  await sql(
    `insert into public.assignments (institution_id, course_id, slug, title, stack_profile_id, template_repo, due_at)
     values ($1, $2, 'final', 'Final project', (select id from public.stack_profiles where key = 'node22-api'), 't/t', now())`,
    [institutionId, course!.id],
  );

  await signIn(page, email("admin"));
  await setUpMfa(page);
  await page.getByRole("navigation", { name: "Institution" }).getByRole("link", { name: "Records" }).click();

  // A full export, built by the worker; the page refreshes until it's ready.
  await page.getByRole("button", { name: "Export all records" }).click();
  const exports = page.getByTestId("exports");
  await expect(exports.getByText("ready")).toBeVisible({ timeout: 60_000 });
  const zip = await page.request.get((await exports.getByRole("link", { name: "Download" }).getAttribute("href"))!);
  expect(zip.ok()).toBe(true);
  const body = await zip.body();
  expect(body.subarray(0, 2).toString()).toBe("PK");
  expect(body.includes(Buffer.from("grades.csv"))).toBe(true);

  // Ending the contract makes the institution read-only and schedules the purge.
  await page.locator("summary", { hasText: "End the contract" }).click();
  await page.getByRole("button", { name: "End the contract" }).click();
  await expect(page.getByText("Tick the box to confirm.")).toBeVisible();
  await page.locator("summary", { hasText: "End the contract" }).click();
  await page.getByLabel(/I understand/).check();
  await page.getByRole("button", { name: "End the contract" }).click();
  await expect(page.getByText("The contract has ended. The institution is now read-only.")).toBeVisible();
  const ended = page.getByTestId("contract-ended");
  await expect(ended.getByText(/will be permanently deleted on/)).toBeVisible();
  const [inst] = await sql<{ status: string; years: number }>(
    "select status, extract(year from age(purge_after, contract_ended_at))::int as years from public.institutions where id = $1",
    [institutionId],
  );
  expect(inst).toEqual({ status: "read_only", years: 2 });
  await expect(page.getByText("read only", { exact: true })).toBeVisible();
});
