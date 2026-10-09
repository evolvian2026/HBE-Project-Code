/**
 * Hidden API tests for the starter templates' example notes API (templates/mern-node20 and
 * templates/django-react): GET and POST /api/notes/ on the backend, and the same through the
 * frontend's proxy. A starting point for an assignment's own suite.
 */
const CATEGORY = "Notes API";

export default {
  tests: [
    {
      id: "notes.list",
      title: "Lists notes as a JSON array",
      category: CATEGORY,
      weight: 1,
      hint: "GET /api/notes/ should answer 200 with a JSON array.",
      async run(t) {
        const res = await t.api.get("/api/notes/");
        t.expectStatus(res, 200);
        t.expect(Array.isArray(res.json), {
          message: "GET /api/notes/ should return a JSON array",
          expected: "a JSON array",
          actual: res.text.slice(0, 200) || "(empty body)",
        });
      },
    },
    {
      id: "notes.create",
      title: "Creates a note",
      category: CATEGORY,
      weight: 2,
      hint: "POST /api/notes/ with a title should answer 201 with the new note (id, title, done).",
      async run(t) {
        const title = t.random.title();
        const res = await t.api.post("/api/notes/", { title });
        t.expectStatus(res, 201);
        t.expect(res.json?.title === title && res.json?.id !== undefined, {
          message: "The created note should be returned with its id and title",
          expected: JSON.stringify({ id: "…", title, done: false }),
          actual: res.text.slice(0, 200),
        });
        const list = await t.api.get("/api/notes/");
        t.expect(
          list.json?.some?.((n) => n.title === title),
          {
            message: "The new note should be in GET /api/notes/",
            expected: `a note titled ${JSON.stringify(title)}`,
            actual: list.text.slice(0, 300),
          },
        );
      },
    },
    {
      id: "notes.requires-title",
      title: "Rejects a note without a title",
      category: CATEGORY,
      weight: 1,
      hint: "POST /api/notes/ with a blank title should answer 400.",
      async run(t) {
        t.expectStatus(await t.api.post("/api/notes/", { title: "  " }), 400);
      },
    },
    {
      id: "notes.frontend-proxy",
      title: "The frontend forwards /api to the backend",
      category: CATEGORY,
      weight: 1,
      hint: "The frontend service should serve /api/notes/ from the backend (see frontend/nginx.conf).",
      async run(t) {
        t.expectStatus(await t.service("frontend").get("/api/notes/"), 200);
      },
    },
  ],
};
