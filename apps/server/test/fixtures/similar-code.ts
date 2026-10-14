/** Source files for the similarity tests: the starter, three independent solutions, and a disguised copy. */

export const STARTER = `import express from "express";

export const app = express();
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString(), uptime: process.uptime() });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Something went wrong" });
});

export function start(port = Number(process.env.PORT ?? 4000)) {
  return app.listen(port, () => console.log(\`listening on \${port}\`));
}
`;

export const ADA = `import { app } from "./app.js";

const todos = new Map();
let nextId = 1;

// Lists every todo, oldest first.
app.get("/todos", (req, res) => {
  res.json([...todos.values()].sort((a, b) => a.id - b.id));
});

app.post("/todos", (req, res) => {
  const title = typeof req.body.title === "string" ? req.body.title.trim() : "";
  if (!title) return res.status(400).json({ error: "title is required" });
  const todo = { id: nextId++, title, done: false, createdAt: Date.now() };
  todos.set(todo.id, todo);
  res.status(201).json(todo);
});

app.patch("/todos/:id", (req, res) => {
  const todo = todos.get(Number(req.params.id));
  if (!todo) return res.status(404).json({ error: "not found" });
  if (typeof req.body.done === "boolean") todo.done = req.body.done;
  if (typeof req.body.title === "string" && req.body.title.trim()) todo.title = req.body.title.trim();
  res.json(todo);
});

app.delete("/todos/:id", (req, res) => {
  if (!todos.delete(Number(req.params.id))) return res.status(404).end();
  res.status(204).end();
});
`;

export const GRACE = `import { app } from "./app.js";

const items = [];

function find(id) {
  return items.find((item) => item.id === id) ?? null;
}

app.get("/todos", (_req, res) => res.json(items));

app.post("/todos", (req, res, next) => {
  try {
    const { title } = req.body ?? {};
    if (!title || !String(title).trim()) {
      res.status(400).json({ message: "missing title" });
      return;
    }
    const created = { id: items.length ? items[items.length - 1].id + 1 : 1, title: String(title).trim(), done: false };
    items.push(created);
    res.status(201).location(\`/todos/\${created.id}\`).json(created);
  } catch (err) {
    next(err);
  }
});

app.put("/todos/:id/done", (req, res) => {
  const item = find(parseInt(req.params.id, 10));
  if (item === null) return res.sendStatus(404);
  item.done = true;
  return res.json(item);
});

app.delete("/todos/:id", (req, res) => {
  const index = items.findIndex((item) => item.id === parseInt(req.params.id, 10));
  if (index < 0) return res.sendStatus(404);
  items.splice(index, 1);
  return res.sendStatus(204);
});
`;

export const LIN = `import { app } from "./app.js";

class TodoStore {
  #rows = [];
  #seq = 0;
  all() {
    return this.#rows.slice();
  }
  add(title) {
    this.#seq += 1;
    const row = { id: this.#seq, title, done: false };
    this.#rows.push(row);
    return row;
  }
  update(id, changes) {
    const row = this.#rows.find((r) => r.id === id);
    if (row) Object.assign(row, changes);
    return row;
  }
  remove(id) {
    const before = this.#rows.length;
    this.#rows = this.#rows.filter((r) => r.id !== id);
    return this.#rows.length < before;
  }
}

const store = new TodoStore();
const idOf = (req) => Number.parseInt(req.params.id, 10);

app.route("/todos")
  .get((req, res) => void res.send(store.all()))
  .post((req, res) => {
    const text = (req.body?.title ?? "").toString().trim();
    return text ? res.status(201).send(store.add(text)) : res.status(400).send({ error: "empty title" });
  });

app.route("/todos/:id")
  .patch((req, res) => {
    const row = store.update(idOf(req), { done: Boolean(req.body?.done) });
    return row ? res.send(row) : res.status(404).send({ error: "unknown todo" });
  })
  .delete((req, res) => (store.remove(idOf(req)) ? res.status(204).end() : res.status(404).end()));
`;

/** Ada's file with every name changed, the comments rewritten and the layout reflowed. */
export const ADA_DISGUISED = ADA.replace("// Lists every todo, oldest first.", "/* all of them */")
  .replace(/todos/g, "tasks")
  .replace(/todo\b/g, "task")
  .replace(/nextId/g, "counter")
  .replace(/title/g, "label")
  .replace(/\n\n/g, "\n");
