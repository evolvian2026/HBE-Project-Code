import { randomInt } from "node:crypto";

/**
 * What a suite's tests get: HTTP clients for the app's services, assertions that say what was
 * expected, and per-run random data (so students can see full failure details without being
 * able to hard-code answers).
 */

export class AssertionFailure extends Error {
  constructor(message, { expected, actual } = {}) {
    super(message);
    this.name = "AssertionFailure";
    this.expected = expected;
    this.actual = actual;
  }
}

const WORDS = [
  "almond",
  "basil",
  "cedar",
  "dune",
  "ember",
  "fjord",
  "garnet",
  "harbor",
  "indigo",
  "juniper",
  "kelp",
  "lagoon",
  "maple",
  "nectar",
  "orchid",
  "pebble",
  "quartz",
  "river",
  "saffron",
  "tundra",
  "umber",
  "violet",
  "willow",
  "yarrow",
  "zephyr",
];
const MAX_BODY = 2000;

const clip = (s, n = MAX_BODY) => (s.length > n ? `${s.slice(0, n)}… (${s.length - n} more characters)` : s);

function describeFetchError(err, timeoutMs) {
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return `no response within ${timeoutMs / 1000} s`;
  const code = err?.cause?.code;
  if (code === "ECONNREFUSED") return "connection refused (is the server listening on the expected port?)";
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET") return "the connection was closed (did the server crash?)";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "the service could not be found (is it running?)";
  return err?.cause?.message ?? err?.message ?? String(err);
}

export function createContext({ services, requestTimeoutMs = 10_000 }) {
  const exchanges = [];
  /** The step a browser test is on (t.step), reported when it fails. */
  const progress = { step: null };

  function client(name) {
    const base = services[name];
    if (!base) throw new Error(`The suite uses service "${name}", which the stack profile does not declare`);
    const call = async (method, path, body, headers = {}) => {
      const url = new URL(path, base);
      const init = {
        method,
        headers: { accept: "application/json", ...headers },
        signal: AbortSignal.timeout(requestTimeoutMs),
      };
      if (body !== undefined) {
        init.body = typeof body === "string" ? body : JSON.stringify(body);
        init.headers["content-type"] ??= "application/json";
      }
      const exchange = {
        request: `${method} ${url.pathname}${url.search}${init.body !== undefined ? `\ncontent-type: ${init.headers["content-type"]}\n\n${clip(init.body)}` : ""}`,
        response: "",
      };
      exchanges.push(exchange);
      let res;
      try {
        res = await fetch(url, init);
      } catch (err) {
        const reason = describeFetchError(err, requestTimeoutMs);
        exchange.response = `(no response: ${reason})`;
        throw new AssertionFailure(`${method} ${url.pathname} failed: ${reason}`, {
          expected: "an HTTP response",
          actual: reason,
        });
      }
      const text = await res.text();
      let json;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }
      const type = res.headers.get("content-type");
      exchange.response = `HTTP ${res.status}${type ? `\ncontent-type: ${type}` : ""}${text ? `\n\n${clip(text)}` : ""}`;
      return { status: res.status, headers: res.headers, text, json, method, path: url.pathname };
    };
    return {
      get: (path, opts) => call("GET", path, undefined, opts?.headers),
      delete: (path, opts) => call("DELETE", path, undefined, opts?.headers),
      post: (path, body, opts) => call("POST", path, body, opts?.headers),
      put: (path, body, opts) => call("PUT", path, body, opts?.headers),
      patch: (path, body, opts) => call("PATCH", path, body, opts?.headers),
    };
  }

  const random = {
    int: (min = 1, max = 1_000_000) => randomInt(min, max + 1),
    word: () => WORDS[randomInt(WORDS.length)],
    title: () => `${random.word()} ${random.word()} ${random.int(10, 9999)}`,
    email: () => `${random.word()}.${random.int(1000, 99999)}@example.test`,
  };

  const t = {
    service: client,
    /** The app's main service: "backend" when the profile has one, otherwise the first. */
    api: client(services.backend ? "backend" : Object.keys(services)[0]),
    random,
    /** Names what the test is doing, so a failure says which step went wrong. */
    async step(name, fn) {
      progress.step = name;
      return fn();
    },
    fail(message, details) {
      throw new AssertionFailure(message, details);
    },
    expect(condition, { message, expected, actual } = {}) {
      if (!condition) throw new AssertionFailure(message ?? "Expectation not met", { expected, actual });
    },
    expectStatus(res, status, message) {
      if (res.status !== status) {
        throw new AssertionFailure(message ?? `${res.method} ${res.path} should answer ${status}`, {
          expected: `HTTP ${status}`,
          actual: `HTTP ${res.status}`,
        });
      }
    },
  };
  return { t, exchanges, progress };
}
