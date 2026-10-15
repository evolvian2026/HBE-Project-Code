import { expect, test } from "@playwright/test";
import { createInstitutionWithAdmin, setUpMfa, signIn, sql } from "./support.ts";

/**
 * Institution addresses (Phase 3E). The server runs with INSTITUTION_BASE_DOMAIN=localhost,
 * so each institution answers at <slug>.localhost:3000 (browsers resolve *.localhost to this
 * machine); the browser maps *.test here too, standing in for a vanity domain's DNS.
 */
test.use({ launchOptions: { args: ["--host-resolver-rules=MAP *.test 127.0.0.1"] } });

const suffix = Date.now().toString(36);
const email = (who: string) => `${who}-${suffix}@e2e.test`;
const slug = `addr-${suffix}`;
const vanity = `projects-${suffix}.test`;

test.afterAll(async () => {
  await sql("delete from public.institutions where slug = $1", [slug]);
  await sql("delete from auth.users where email like $1", [`%-${suffix}@e2e.test`]);
});

test("an institution has its own subdomain and domain, and people sign in once", async ({ browser }) => {
  test.setTimeout(120_000);
  const institutionId = await createInstitutionWithAdmin(slug, `Address U ${suffix}`, email("admin"));
  await sql("insert into public.invitations (institution_id, email, role) values ($1, $2, 'student')", [
    institutionId,
    email("student"),
  ]);

  // The admin sees the subdomain and adds a domain of their own.
  const admin = await (await browser.newContext()).newPage();
  await signIn(admin, email("admin"));
  await setUpMfa(admin);
  await admin.goto(`/i/${slug}/settings`);
  const card = admin.locator("#address");
  await expect(card.getByRole("link", { name: `${slug}.localhost:3000` })).toHaveAttribute(
    "href",
    `http://${slug}.localhost:3000`,
  );
  await card.getByLabel("Your own domain (optional)").fill(`https://${vanity.toUpperCase()}/`);
  await card.getByRole("button", { name: "Add domain" }).click();
  await expect(card.getByText("Added. Set the DNS records below, then check.")).toBeVisible();
  await expect(card.getByTestId("domain-status")).toContainText(`${vanity}waiting for the DNS record`);
  await expect(card.getByRole("cell", { name: `_hbe-verify.${vanity}` })).toBeVisible();
  await card.getByRole("button", { name: "Check now" }).click();
  await expect(card.getByText(/No matching TXT record|DNS lookup failed/).first()).toBeVisible();

  // Its DNS record is found (simulated: there is no real DNS here); the operator turns it on.
  await sql("update public.institution_domains set status = 'provisioning', verified_at = now() where hostname = $1", [
    vanity,
  ]);
  const operator = await (await browser.newContext()).newPage();
  await signIn(operator, email("operator"));
  await sql("insert into public.user_roles (user_id, role) select id, 'super_admin' from auth.users where email = $1", [
    email("operator"),
  ]);
  await operator.goto("/platform");
  await setUpMfa(operator);
  await operator.goto("/platform/domains");
  await operator.getByRole("button", { name: `Mark ${vanity} live` }).click();
  await expect(operator.getByText("The domain is live.")).toBeVisible();

  // A student signed in on the platform opens the subdomain: signed in there too, at home.
  const context = await browser.newContext();
  const student = await context.newPage();
  await signIn(student, email("student"));
  await student.goto(`http://${slug}.localhost:3000/`);
  await expect(student).toHaveURL(`http://${slug}.localhost:3000/`);
  await expect(student.getByRole("heading", { name: `Address U ${suffix}` })).toBeVisible();
  await student.goto(`http://${slug}.localhost:3000/grades`);
  await expect(student).toHaveURL(`http://${slug}.localhost:3000/grades`);
  await expect(student.getByRole("heading", { name: `Address U ${suffix}` })).toBeVisible();

  // And the institution's own domain.
  await student.goto(`http://${vanity}:3000/`);
  await expect(student).toHaveURL(`http://${vanity}:3000/`);
  await expect(student.getByRole("heading", { name: `Address U ${suffix}` })).toBeVisible();

  // Addresses no institution has are not served.
  const unknown = await student.goto(`http://nobody-${suffix}.localhost:3000/`);
  expect(unknown?.status()).toBe(404);
  await student.goto(`http://${slug}.localhost:3000/`);

  // Signing out there signs out of the platform's address too.
  await student.getByRole("button", { name: "Sign out" }).click();
  await expect(student).toHaveURL(/^http:\/\/localhost:3000\/login/);
  await student.goto("/");
  await expect(student).toHaveURL(/^http:\/\/localhost:3000\/login/);
  await student.goto(`http://${slug}.localhost:3000/`);
  await expect(student).toHaveURL(/^http:\/\/localhost:3000\/login/);
});
