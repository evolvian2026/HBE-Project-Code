/** Hidden browser test for the starter templates' notes page. */
export default {
  tests: [
    {
      id: "ui.add-note",
      title: "Adds a note from the page",
      category: "Notes page",
      weight: 2,
      hint: "After the “New note” form is submitted, the note should appear in the list without reloading.",
      async run(t) {
        const title = t.random.title();
        await t.step("Open the home page", () => t.page.goto("/"));
        await t.step(`Type “${title}” into “New note”`, () => t.page.getByLabel("New note").fill(title));
        await t.step("Click “Add”", () => t.page.getByRole("button", { name: "Add" }).click());
        await t.step(`See “${title}” in the list`, () =>
          t.page.getByRole("list", { name: "Notes" }).getByText(title).waitFor({ timeout: 5000 }),
        );
      },
    },
  ],
};
