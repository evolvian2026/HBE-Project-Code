import { describe, expect, it } from "vitest";
import { fingerprint, isComparable, similarPairs, tokenize, type SourceFile } from "./similarity.ts";

// Two independent ways of writing the same small API, and a third file that shares nothing.
const ADA = `import express from "express";

const app = express();
const todos = new Map();
let nextId = 1;

app.use(express.json());

// Lists every todo, oldest first.
app.get("/todos", (req, res) => {
  res.json([...todos.values()].sort((a, b) => a.id - b.id));
});

app.post("/todos", (req, res) => {
  const title = typeof req.body.title === "string" ? req.body.title.trim() : "";
  if (!title) return res.status(400).json({ error: "title is required" });
  const todo = { id: nextId++, title, done: false };
  todos.set(todo.id, todo);
  res.status(201).json(todo);
});

app.patch("/todos/:id", (req, res) => {
  const todo = todos.get(Number(req.params.id));
  if (!todo) return res.status(404).json({ error: "not found" });
  if (typeof req.body.done === "boolean") todo.done = req.body.done;
  res.json(todo);
});

app.delete("/todos/:id", (req, res) => {
  if (!todos.delete(Number(req.params.id))) return res.status(404).end();
  res.status(204).end();
});

export default app;
`;

const GRACE = `import { createServer } from "node:http";

const items = [];

function reply(response, code, payload) {
  response.writeHead(code, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function body(request) {
  let raw = "";
  for await (const part of request) raw += part;
  return raw ? JSON.parse(raw) : {};
}

export const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://x");
  if (request.method === "GET" && url.pathname === "/todos") return reply(response, 200, items);
  if (request.method === "POST" && url.pathname === "/todos") {
    const data = await body(request);
    if (!data.title || !String(data.title).trim()) return reply(response, 400, { message: "missing title" });
    const created = { id: items.length + 1, title: String(data.title).trim(), done: false };
    items.push(created);
    return reply(response, 201, created);
  }
  const match = /^\\/todos\\/(\\d+)$/.exec(url.pathname);
  const found = match && items.find((t) => t.id === Number(match[1]));
  if (!found) return reply(response, 404, { message: "no such todo" });
  if (request.method === "DELETE") {
    items.splice(items.indexOf(found), 1);
    response.writeHead(204);
    return response.end();
  }
  return reply(response, 405, { message: "not allowed" });
});
`;

/** ADA's file with every name changed, the comments rewritten and the layout reflowed. */
const ADA_RENAMED = ADA.replace(/todos/g, "tasks")
  .replace(/todo\b/g, "task")
  .replace(/nextId/g, "counter")
  .replace(/title/g, "label")
  .replace(/\/\/ Lists every todo, oldest first\./, "/* all tasks */")
  .replace(/\n\n/g, "\n");

const repo = (files: Record<string, string>): SourceFile[] =>
  Object.entries(files).map(([path, text]) => ({ path, text }));

describe("tokens", () => {
  it("ignore comments, layout, names, strings and numbers", () => {
    const a = tokenize("const total = price * 2; // the total\n");
    const b = tokenize("const   sum=cost*3 /* other */;");
    expect(a.map((t) => t.t)).toEqual(b.map((t) => t.t));
    expect(a.map((t) => t.t)).toEqual(["const", "v", "=", "v", "*", "n", ";"]);
  });

  it("know Python's comments and strings, and keep lines", () => {
    const tokens = tokenize('def f(x):\n    # note\n    return """doc\nmore""" + x\n', "a.py");
    expect(tokens.map((t) => t.t)).toEqual(["def", "v", "(", "v", ")", ":", "return", "s", "+", "v"]);
    expect(tokens.at(-1)!.line).toBe(4);
  });

  it("compare source files only", () => {
    expect(isComparable("src/app.js")).toBe(true);
    expect(isComparable("backend/notes/views.py")).toBe(true);
    expect(isComparable("node_modules/x/index.js")).toBe(false);
    expect(isComparable("dist/app.min.js")).toBe(false);
    expect(isComparable("README.md")).toBe(false);
  });
});

describe("similar pairs", () => {
  const subs = (entries: [string, SourceFile[]][]) =>
    entries.map(([id, files]) => ({ id, fingerprints: fingerprint(files) }));

  it("find a copy with renamed names and rewritten comments, and where it is", () => {
    const pairs = similarPairs(
      subs([
        ["ada", repo({ "src/app.js": ADA })],
        ["grace", repo({ "server.js": GRACE })],
        ["copy", repo({ "src/index.js": ADA_RENAMED })],
      ]),
    );
    expect(pairs.map((p) => [p.a, p.b])).toEqual([["ada", "copy"]]);
    expect(pairs[0]!.score).toBeGreaterThan(0.9);
    const top = pairs[0]!.matches[0]!;
    expect([top.a.path, top.b.path]).toEqual(["src/app.js", "src/index.js"]);
    expect(top.a.from).toBeLessThanOrEqual(10);
    expect(top.a.to).toBeGreaterThan(25);
  });

  it("ignore the starter code everyone was given", () => {
    const starter = repo({ "src/app.js": ADA });
    const entries: [string, SourceFile[]][] = [
      ["ada", repo({ "src/app.js": ADA, "src/extra.js": GRACE })],
      ["copy", repo({ "src/app.js": ADA })],
    ];
    expect(similarPairs(subs(entries), fingerprint(starter)).map((p) => [p.a, p.b])).toEqual([]);
    expect(similarPairs(subs(entries)).map((p) => [p.a, p.b])).toEqual([["ada", "copy"]]);
  });

  it("ignore code most submissions share (boilerplate)", () => {
    const entries: [string, SourceFile[]][] = ["a", "b", "c", "d", "e"].map((id) => [id, repo({ "src/app.js": ADA })]);
    expect(similarPairs(subs(entries))).toEqual([]);
  });
});
