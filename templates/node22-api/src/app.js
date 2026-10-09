/**
 * The app's HTTP handler. Start here: add your routes to `routes`.
 * The grader starts the app with Docker Compose and checks GET /health before the tests run.
 */

/** Sends a JSON response. */
export function send(res, status, body) {
  res.writeHead(status, body === undefined ? {} : { "content-type": "application/json" });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

/** Reads a JSON request body; null if it isn't valid JSON. */
export async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return null;
  }
}

const routes = {
  "GET /health": (req, res) => send(res, 200, { status: "ok" }),
  "GET /hello": (req, res, url) => send(res, 200, { message: `Hello, ${url.searchParams.get("name") ?? "world"}!` }),
};

export async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  const route = routes[`${req.method} ${url.pathname}`];
  if (!route) return send(res, 404, { error: "Not found" });
  try {
    await route(req, res, url);
  } catch (err) {
    console.error(err);
    send(res, 500, { error: "Something went wrong" });
  }
}
