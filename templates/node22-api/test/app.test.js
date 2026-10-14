import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { after, before, test } from "node:test";
import { handle, readJson } from "../src/app.js";

let base;
const server = createServer(handle);
before(async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

test("GET /health answers 200", async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok" });
});

test("GET /hello greets by name", async () => {
  const res = await fetch(`${base}/hello?name=Ada`);
  assert.deepEqual(await res.json(), { message: "Hello, Ada!" });
});

test("unknown routes answer 404", async () => {
  assert.equal((await fetch(`${base}/nope`)).status, 404);
});

test("readJson parses the body, and returns null for invalid JSON", async () => {
  assert.deepEqual(await readJson(Readable.from(['{"title":', '"Buy milk"}'])), { title: "Buy milk" });
  assert.deepEqual(await readJson(Readable.from([])), {});
  assert.equal(await readJson(Readable.from(["{oops"])), null);
});
