import { expect, test, type Browser } from "@playwright/test";
import { signIn, sql } from "./support.ts";

const suffix = Date.now().toString(36);
const email = (who: string) => `${who}-${suffix}@e2e.test`;
const slug = `team-${suffix}`;

test.afterAll(async () => {
  await sql("delete from public.institutions where slug = $1", [slug]);
  await sql("delete from auth.users where email like $1", [`%-${suffix}@e2e.test`]);
  await sql("delete from public.github_installations where account_login = $1", [`org-${suffix}`]);
});

/** A student who has signed in and linked GitHub (the identity is simulated). */
async function student(browser: Browser, who: string) {
  const page = await (await browser.newContext()).newPage();
  await signIn(page, email(who));
  await sql(
    `insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at, last_sign_in_at)
     select $2, id, jsonb_build_object('user_name', $3::text), 'github', now(), now(), now()
     from auth.users where email = $1`,
    [email(who), String(Math.floor(Math.random() * 1e9)), `${who}-${suffix}`],
  );
  return page;
}

test("a teacher forms teams and publishes a team assignment; each team shares a repository", async ({ browser }) => {
  test.setTimeout(150_000);
  const [inst] = await sql<{ id: string }>(
    "insert into public.institutions (name, slug) values ($1, $2) returning id",
    [`Team U ${suffix}`, slug],
  );
  const [gh] = await sql<{ id: string }>(
    "insert into public.github_installations (institution_id, installation_id, account_id, account_login, account_type) values ($1, $2, 1, $3, 'Organization') returning id",
    [inst!.id, Math.floor(Math.random() * 1e9), `org-${suffix}`],
  );
  const [course] = await sql<{ id: string }>(
    "insert into public.courses (institution_id, code, name, term, github_installation_id) values ($1, 'SE300', 'Software Engineering', '2026-T1', $2) returning id",
    [inst!.id, gh!.id],
  );
  await sql(
    `insert into public.invitations (institution_id, email, role, course_id, course_role)
     select $1, e, case when e = $2 then 'teacher'::public.institution_role else 'student' end, $3,
            case when e = $2 then 'instructor'::public.course_role else 'student' end
     from unnest($4::text[]) e`,
    [inst!.id, email("teacher"), course!.id, [email("teacher"), email("ada"), email("grace"), email("linus")]],
  );
  const ada = await student(browser, "ada");
  const grace = await student(browser, "grace");
  await student(browser, "linus");

  // The teacher forms two teams on the course page.
  const teacher = await (await browser.newContext()).newPage();
  await signIn(teacher, email("teacher"));
  await teacher.goto(`/i/${slug}/courses/${course!.id}`);
  const teams = teacher.locator("#teams");
  for (const name of ["Red", "Blue"]) {
    await teams.getByLabel("Team name").fill(name);
    await teams.getByRole("button", { name: "Create team" }).click();
    await expect(teacher.getByText(`Team “${name}” created.`)).toBeVisible();
  }
  const add = async (team: string, who: string) => {
    await teams.getByLabel(`Add a student to ${team}`).selectOption({ label: email(who) });
    await teams.locator("li", { hasText: team }).getByRole("button", { name: "Add" }).click();
    await expect(teacher.getByText("Added to the team.")).toBeVisible();
  };
  await add("Red", "ada");
  await add("Red", "grace");
  await add("Blue", "linus");
  await expect(teams.getByTestId("teams")).toContainText(email("grace"));

  // A team assignment.
  await teacher.getByRole("link", { name: "New assignment" }).click();
  await teacher.getByLabel("Title").fill("Group shop");
  await teacher.getByLabel("Individual or team work").selectOption("team");
  await teacher.getByLabel("Template repository").fill("hbe-templates/mern-starter");
  const suite = teacher.getByLabel("Hidden test suite");
  await suite.selectOption(
    (await suite.locator("option", { hasText: "Todo API (sample suite)" }).getAttribute("value"))!,
  );
  await teacher.getByRole("button", { name: "Create draft" }).click();
  await expect(teacher.getByRole("heading", { name: /Group shop/ })).toBeVisible();
  await teacher.getByLabel("Criterion").fill("Teamwork");
  await teacher.getByRole("button", { name: "Add criterion" }).click();
  await expect(teacher.getByText("Each team gets a repository from the template")).toBeVisible();
  await teacher.getByRole("button", { name: "Publish to students" }).click();
  await expect(
    teacher.getByText("Published. Each team gets a repository, shared by its members (3 students)."),
  ).toBeVisible();

  // Each team's members share one repository.
  await expect
    .poll(
      async () =>
        (
          await sql<{ n: number }>(
            `select count(*)::int as n from public.submissions s join public.assignments a on a.id = s.assignment_id
       where a.course_id = $1 and s.status = 'active'`,
            [course!.id],
          )
        )[0]!.n,
      { timeout: 30_000 },
    )
    .toBe(3);
  const [after] = await sql<{ n: number; red: string }>(
    `select count(distinct s.repository_id)::int as n, max(r.name) filter (where t.slug = 'red') as red
     from public.submissions s join public.teams t on t.id = s.team_id join public.repositories r on r.id = s.repository_id
     where t.course_id = $1`,
    [course!.id],
  );
  expect(after!.n).toBe(2);
  expect(after!.red).toMatch(/^group-shop-red-[0-9a-f]{6}$/);

  for (const page of [ada, grace]) {
    await page.goto(`/i/${slug}/courses/${course!.id}`);
    await expect(page.getByTestId("my-team")).toHaveText("Red");
    await page.getByRole("link", { name: "Group shop" }).click();
    await expect(page.getByText("Your team's repository")).toBeVisible();
    await expect(page.getByRole("link", { name: new RegExp(`org-${suffix}/${after!.red}`) })).toBeVisible();
  }

  // Staff see the members grouped by team.
  await teacher.reload();
  const list = teacher.locator("section", { hasText: "Submissions" });
  await expect(list.getByText("Red", { exact: true })).toHaveCount(2);
  await expect(list.getByText("Blue", { exact: true }).first()).toBeVisible();
});
