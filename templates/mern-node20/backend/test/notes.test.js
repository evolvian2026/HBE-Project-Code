import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { noteProblem } from "../src/notes.js";

test("a note needs a title", () => {
  assert.equal(noteProblem({ title: "Buy milk" }), null);
  assert.equal(noteProblem({ title: "  " }), "title is required");
  assert.equal(noteProblem({}), "title is required");
});

test("GET /health answers without a database", async () => {
  const server = createApp().listen(0);
  try {
    const res = await fetch(`http://localhost:${server.address().port}/health`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, "ok");
  } finally {
    server.close();
  }
});
