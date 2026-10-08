// A buggy "Todo API" submission (a grader test fixture): no title validation, and DELETE
// answers 200 without removing anything.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const todos = new Map();

function send(res, status, body) {
  res.writeHead(status, body === undefined ? {} : { "content-type": "application/json" });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return null;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const [, collection, id] = url.pathname.split("/");
  if (url.pathname === "/health") return send(res, 200, { status: "ok" });
  if (collection !== "todos") return send(res, 404, { error: "Not found" });

  if (!id && req.method === "GET") return send(res, 200, [...todos.values()]);
  if (!id && req.method === "POST") {
    const body = await readJson(req);
    const title = typeof body?.title === "string" ? body.title.trim() : "";
    const todo = { id: randomUUID(), title, done: false };
    todos.set(todo.id, todo);
    return send(res, 201, todo);
  }

  const todo = todos.get(id);
  if (!todo) return send(res, 404, { error: "Todo not found" });
  if (req.method === "GET") return send(res, 200, todo);
  if (req.method === "PATCH") {
    const body = await readJson(req);
    if (typeof body?.done === "boolean") todo.done = body.done;
    if (typeof body?.title === "string" && body.title.trim()) todo.title = body.title.trim();
    return send(res, 200, todo);
  }
  if (req.method === "DELETE") {
    console.error(`delete ${id}: not implemented yet`);
    return send(res, 200, todo);
  }
  return send(res, 405, { error: "Method not allowed" });
});

server.listen(Number(process.env.PORT ?? 4000), () => console.log("todo api listening"));
