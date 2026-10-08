/**
 * Hidden browser tests for the sample todo app's web page. Each test gets a fresh browser page
 * (`t.page`, Playwright) opened on the app's frontend (or its only service). `t.step` names
 * what the test is doing, so a failure says which step went wrong; failures come with a
 * screenshot and a Playwright trace.
 */
const CATEGORY = "Web app";

export default {
  tests: [
    {
      id: "ui.home",
      title: "Shows the todo list page",
      category: CATEGORY,
      weight: 1,
      hint: "Opening / should show a page with a “Todos” heading.",
      async run(t) {
        await t.step("Open the home page", () => t.page.goto("/"));
        await t.step("Find the “Todos” heading", () => t.page.getByRole("heading", { name: "Todos" }).waitFor());
      },
    },
    {
      id: "ui.add",
      title: "Adds a todo from the form",
      category: CATEGORY,
      weight: 2,
      hint: "After the “New todo” form is submitted, the new todo should appear in the list without reloading the page.",
      staff_notes: "Usually the list isn't updated after the POST succeeds (no re-render or append).",
      async run(t) {
        const title = t.random.title();
        await t.step("Open the home page", () => t.page.goto("/"));
        await t.step(`Type “${title}” into “New todo”`, () => t.page.getByLabel("New todo").fill(title));
        await t.step("Click “Add”", () => t.page.getByRole("button", { name: "Add" }).click());
        await t.step(`See “${title}” in the list`, () =>
          t.page.getByRole("list", { name: "Todos" }).getByText(title).waitFor({ timeout: 5000 }),
        );
      },
    },
  ],
};
