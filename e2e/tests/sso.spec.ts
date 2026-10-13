import { expect, test } from "@playwright/test";
import { startFakeIdp, type FakeIdp } from "./fake-idp.ts";
import { createInstitutionWithAdmin, setUpMfa, signIn, sql } from "./support.ts";

// Needs SAML on in the local Auth server (scripts/local-saml.sh) and HBE__FEATURES__SAML_SSO=true.
const suffix = Date.now().toString(36);
const email = (who: string) => `${who}-${suffix}@e2e.test`;
const slug = `sso-${suffix}`;
const name = `SSO U ${suffix}`;
const domain = `uni-${suffix}.test`;
let idp: FakeIdp;

test.beforeAll(async () => {
  idp = await startFakeIdp(54395);
});
test.afterAll(async () => {
  await idp.close();
  await sql(
    "delete from auth.sso_providers where id in (select supabase_provider_id from public.sso_connections c join public.institutions i on i.id = c.institution_id where i.slug = $1)",
    [slug],
  );
  await sql("delete from public.institutions where slug like $1", [`%${suffix}`]);
  await sql("delete from auth.users where email like $1 or email like $2", [`%-${suffix}@e2e.test`, `%@${domain}`]);
});

test("an institution signs its people in through its identity provider, once the operator checks its domain", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const institutionId = await createInstitutionWithAdmin(slug, name, email("admin"));
  // Another institution invited the same address: SSO can't be used to take that invitation.
  const [other] = await sql<{ id: string }>(
    "insert into public.institutions (name, slug) values ($1, $2) returning id",
    [`Other ${suffix}`, `other-${suffix}`],
  );
  await sql("insert into public.invitations (institution_id, email, role) values ($1, $2, 'teacher')", [
    other!.id,
    `grace@${domain}`,
  ]);

  // The admin asks for single sign-on with the IdP's metadata and their domain.
  const admin = await (await browser.newContext()).newPage();
  await signIn(admin, email("admin"));
  await setUpMfa(admin);
  await admin.goto(`/i/${slug}/settings`);
  const card = admin.locator("#sso");
  await card.getByLabel("Email domains").fill(domain);
  await card.getByLabel("…or its metadata file (XML)").fill(idp.metadataXml);
  await card.getByLabel("People from these domains who sign in join as students").check();
  await card.getByRole("button", { name: "Ask to turn it on" }).click();
  await expect(admin.getByText("Sent to the platform operator")).toBeVisible();
  await expect(card.getByTestId("sso-status")).toContainText("waiting for the platform operator");

  // The operator turns it on.
  const operator = await (await browser.newContext()).newPage();
  await signIn(operator, email("operator"));
  await sql("insert into public.user_roles (user_id, role) select id, 'super_admin' from auth.users where email = $1", [
    email("operator"),
  ]);
  await operator.goto("/platform");
  await setUpMfa(operator);
  await operator
    .getByRole("form", { name: `Review single sign-on for ${name}` })
    .getByRole("button", { name: "Turn on" })
    .click();
  await expect(operator.getByText("Single sign-on turned on.")).toBeVisible();

  // Grace signs in with her university account and joins as a student.
  const grace = await (await browser.newContext()).newPage();
  await grace.goto("/login");
  await grace.getByText("Use your institution's single sign-on").click();
  await grace.getByLabel("Institution email").fill(`grace@${domain}`);
  await grace.getByRole("button", { name: "Continue with single sign-on" }).click();
  await expect(grace.getByRole("heading", { name: "Example University sign-in" })).toBeVisible();
  await grace.getByLabel("University email").fill(`grace@${domain}`);
  await grace.getByRole("button", { name: "Sign in" }).click();
  await expect(grace).toHaveURL(new RegExp(`/i/${slug}$`), { timeout: 15_000 });
  await expect(grace.getByText("You are")).toContainText("student");

  const memberships = await sql<{ institution_id: string; role: string }>(
    `select m.institution_id, m.role::text from public.institution_memberships m
     join auth.users u on u.id = m.user_id where u.email = $1`,
    [`grace@${domain}`],
  );
  expect(memberships).toEqual([{ institution_id: institutionId, role: "student" }]);
  const [pending] = await sql<{ accepted_at: string | null }>(
    "select accepted_at from public.invitations where institution_id = $1",
    [other!.id],
  );
  expect(pending!.accepted_at).toBeNull();

  // Turned off, the IdP no longer signs anyone in.
  await admin.reload();
  await card.getByRole("button", { name: "Turn off single sign-on" }).click();
  await expect(admin.getByText("Single sign-on is off.")).toBeVisible();
  const later = await (await browser.newContext()).newPage();
  await later.goto("/login?sso=1");
  await later.getByLabel("Institution email").fill(`linus@${domain}`);
  await later.getByRole("button", { name: "Continue with single sign-on" }).click();
  await expect(later.getByText(`${domain} doesn't use single sign-on here.`)).toBeVisible();
});
