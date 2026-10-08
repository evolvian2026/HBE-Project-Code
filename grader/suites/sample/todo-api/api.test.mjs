/**
 * Hidden tests for the sample "Todo API" assignment. Black-box: they only talk HTTP to the
 * running app. Every test has a title, a hint and assertions that say what was expected;
 * data is random per run.
 */
const CATEGORY = "Todos API";

/** Creates a todo and returns it, failing with a clear message if that doesn't work. */
async function createTodo(t, title = t.random.title()) {
  const res = await t.api.post("/todos", { title });
  t.expectStatus(res, 201, "Creating a todo with POST /todos should answer 201 Created");
  t.expect(res.json && typeof res.json === "object" && res.json.id !== undefined, {
    message: "The created todo should be returned as JSON with an id",
    expected: '{ "id": …, "title": …, "done": false }',
    actual: res.text.slice(0, 200) || "(empty body)",
  });
  return res.json;
}

export default {
  tests: [
    {
      id: "todos.list",
      title: "Lists todos as a JSON array",
      category: CATEGORY,
      weight: 1,
      hint: "GET /todos should answer 200 with a JSON array (empty at first).",
      async run(t) {
        const res = await t.api.get("/todos");
        t.expectStatus(res, 200);
        t.expect(Array.isArray(res.json), {
          message: "GET /todos should return a JSON array",
          expected: "a JSON array",
          actual: res.text.slice(0, 200) || "(empty body)",
        });
      },
    },
    {
      id: "todos.create",
      title: "Creates a todo",
      category: CATEGORY,
      weight: 2,
      hint: "POST /todos with { title } should store the todo and answer 201 with { id, title, done: false }.",
      staff_notes: "Common causes: not parsing the JSON body, or answering 200 instead of 201.",
      async run(t) {
        const title = t.random.title();
        const todo = await createTodo(t, title);
        t.expect(todo.title === title, {
          message: "The created todo should have the title that was sent",
          expected: JSON.stringify(title),
          actual: JSON.stringify(todo.title),
        });
        t.expect(todo.done === false, {
          message: "A new todo should not be done",
          expected: "done: false",
          actual: `done: ${JSON.stringify(todo.done)}`,
        });
        const list = await t.api.get("/todos");
        t.expect(Array.isArray(list.json) && list.json.some((x) => x.id === todo.id), {
          message: "The new todo should appear in GET /todos",
          expected: `a todo with id ${JSON.stringify(todo.id)}`,
          actual: list.text.slice(0, 200),
        });
      },
    },
    {
      id: "todos.create-requires-title",
      title: "Rejects a todo without a title",
      category: CATEGORY,
      weight: 1,
      hint: "Validate the request body: answer 400 Bad Request when the title is missing or blank.",
      staff_notes: "Students often trust the body; look for a missing check before saving.",
      async run(t) {
        const res = await t.api.post("/todos", { title: "   " });
        t.expectStatus(res, 400, "POST /todos with a blank title should answer 400 Bad Request");
      },
    },
    {
      id: "todos.get",
      title: "Fetches a todo by id",
      category: CATEGORY,
      weight: 1,
      hint: "GET /todos/:id should answer 200 with that todo.",
      async run(t) {
        const todo = await createTodo(t);
        const res = await t.api.get(`/todos/${encodeURIComponent(todo.id)}`);
        t.expectStatus(res, 200);
        t.expect(res.json?.id === todo.id && res.json?.title === todo.title, {
          message: "GET /todos/:id should return the requested todo",
          expected: JSON.stringify({ id: todo.id, title: todo.title }),
          actual: res.text.slice(0, 200),
        });
      },
    },
    {
      id: "todos.get-missing",
      title: "Answers 404 for an unknown todo",
      category: CATEGORY,
      weight: 1,
      hint: "When no todo has that id, answer 404 Not Found instead of 200 or 500.",
      async run(t) {
        const res = await t.api.get(`/todos/missing-${t.random.int()}`);
        t.expectStatus(res, 404);
      },
    },
    {
      id: "todos.complete",
      title: "Marks a todo as done",
      category: CATEGORY,
      weight: 2,
      hint: "PATCH /todos/:id with { done: true } should update the todo, answer 200 and keep the change.",
      async run(t) {
        const todo = await createTodo(t);
        const res = await t.api.patch(`/todos/${encodeURIComponent(todo.id)}`, { done: true });
        t.expectStatus(res, 200);
        const after = await t.api.get(`/todos/${encodeURIComponent(todo.id)}`);
        t.expect(after.json?.done === true, {
          message: "After PATCH { done: true }, GET /todos/:id should show the todo as done",
          expected: "done: true",
          actual: `done: ${JSON.stringify(after.json?.done)}`,
        });
      },
    },
    {
      id: "todos.delete",
      title: "Deletes a todo",
      category: CATEGORY,
      weight: 2,
      hint: "DELETE /todos/:id should remove the todo and answer 204 No Content; fetching it afterwards gives 404.",
      staff_notes: "A 200 with the todo still present usually means the delete handler is a stub.",
      async run(t) {
        const todo = await createTodo(t);
        const res = await t.api.delete(`/todos/${encodeURIComponent(todo.id)}`);
        t.expectStatus(res, 204);
        const after = await t.api.get(`/todos/${encodeURIComponent(todo.id)}`);
        t.expectStatus(after, 404, "A deleted todo should no longer be found");
      },
    },
  ],
};
