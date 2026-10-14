import { randomBytes, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createInstitutionWithAdmin, signIn, sql } from "./support.ts";

const suffix = Date.now().toString(36);
const email = (who: string) => `${who}-${suffix}@e2e.test`;
const slug = `alike-${suffix}`;

test.afterAll(async () => {
  await sql("delete from public.institutions where slug = $1", [slug]);
  await sql("delete from auth.users where email like $1", [`%-${suffix}@e2e.test`]);
});

test("course staff see which submissions have similar code, and students can't", async ({ browser }) => {
  test.setTimeout(120_000);
  const institutionId = await createInstitutionWithAdmin(slug, `Alike U ${suffix}`, email("admin"));
  const [course] = await sql<{ id: string }>(
    "insert into public.courses (institution_id, code, name, term) values ($1, 'WEB101', 'Web Development', '2026-T1') returning id",
    [institutionId],
  );
  const [assignment] = await sql<{ id: string }>(
    `insert into public.assignments (institution_id, course_id, slug, title, stack_profile_id, template_repo, due_at, status, published_at)
     values ($1, $2, 'todo-api', 'Todo API', (select id from public.stack_profiles where key = 'node22-api'), 't/t',
             now() - interval '1 day', 'published', now() - interval '10 days') returning id`,
    [institutionId, course!.id],
  );
  await sql(
    `insert into public.invitations (institution_id, email, role, course_id, course_role) values
       ($1, $2, 'teacher', $3, 'instructor'), ($1, $4, 'student', $3, 'student')`,
    [institutionId, email("teacher"), course!.id, email("ada")],
  );

  // Two graded submissions (neither archived here) and a finished check that paired them.
  const ids: string[] = [];
  for (const name of ["Grace Hopper", "Lin Wei"]) {
    const id = randomUUID();
    await sql(
      `insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
       values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, now(),
               '{"provider":"email","providers":["email"]}', jsonb_build_object('full_name', $3::text), now(), now())`,
      [id, email(name.split(" ")[0]!.toLowerCase()), name],
    );
    await sql("insert into public.institution_memberships (institution_id, user_id, role) values ($1, $2, 'student')", [
      institutionId,
      id,
    ]);
    const [s] = await sql<{ id: string }>(
      `insert into public.submissions (institution_id, assignment_id, user_id, status, final_sha, finalized_at)
       values ($1, $2, $3, 'graded', $4, now()) returning id`,
      [institutionId, assignment!.id, id, randomBytes(20).toString("hex")],
    );
    ids.push(s!.id);
  }
  const [report] = await sql<{ id: string }>(
    `insert into public.similarity_reports (institution_id, assignment_id, status, compared, starter_excluded, finished_at)
     values ($1, $2, 'completed', 2, true, now()) returning id`,
    [institutionId, assignment!.id],
  );
  await sql(
    `insert into public.similarity_pairs (institution_id, report_id, submission_a, submission_b, score, shared, matches)
     values ($1, $2, $3, $4, 0.931, 68, $5)`,
    [
      institutionId,
      report!.id,
      ids[0],
      ids[1],
      JSON.stringify([
        {
          a: { path: "src/todos.js", from: 3, to: 31 },
          b: { path: "src/tasks.js", from: 2, to: 27 },
          fingerprints: 61,
        },
        { a: { path: "src/db.js", from: 1, to: 9 }, b: { path: "src/store.js", from: 4, to: 12 }, fingerprints: 7 },
      ]),
    ],
  );

  const teacher = await (await browser.newContext()).newPage();
  await signIn(teacher, email("teacher"));
  await teacher.goto(`/i/${slug}/courses/${course!.id}/assignments/${assignment!.id}`);
  await teacher.getByRole("link", { name: "Similar code" }).click();
  await expect(teacher.getByRole("heading", { name: "Similar code", exact: true })).toBeVisible();
  await expect(teacher.getByText(/Compared 2 repositories on .* The starter code was left out\./)).toBeVisible();
  const bars = teacher.getByRole("list", { name: "Similarity of each pair" });
  await expect(bars.getByRole("listitem")).toHaveText(["Grace Hopper · Lin Wei93%"]);
  const pair = teacher.getByTestId("similar-pair");
  await expect(pair).toContainText("93% similar · 2 matching passages");
  await pair.locator("summary").click();
  const passage = pair.getByRole("link", { name: "src/todos.js:3–31" });
  await expect(passage).toHaveAttribute(
    "href",
    new RegExp(`/submissions/${ids[0]}/code\\?sha=[0-9a-f]{40}&path=src%2Ftodos\\.js&line=3#L3$`),
  );
  await expect(pair.getByRole("link", { name: "src/tasks.js:2–27" })).toBeVisible();

  // Checking again runs in the worker: these commits weren't archived, so nothing is compared.
  await teacher.getByRole("button", { name: "Check again" }).click();
  await expect(async () => {
    await teacher.reload();
    await expect(teacher.getByText("Compared 0 repositories", { exact: false })).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 30_000 });
  await teacher.getByText("2 not compared").click();
  await expect(teacher.getByText("The graded commit wasn't archived.")).toHaveCount(2);
  await expect(teacher.getByText("No similar pairs")).toBeVisible();

  // Students never see it.
  const student = await (await browser.newContext()).newPage();
  await signIn(student, email("ada"));
  const res = await student.goto(`/i/${slug}/courses/${course!.id}/assignments/${assignment!.id}/similarity`);
  expect(res?.status()).toBe(404);
});
