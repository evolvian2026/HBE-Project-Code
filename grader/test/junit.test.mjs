import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseJUnit } from "../harness/lib/junit.mjs";

describe("parseJUnit", () => {
  it("reads node:test reports", () => {
    const report = parseJUnit(`<?xml version="1.0" encoding="utf-8"?>
<testsuites>
  <testcase name="accepts a normal title" time="0.0008" classname="test"/>
  <testcase name="rejects an empty title" time="0.0002" classname="test" failure="Expected values">
    <failure type="testCodeFailure" message="Expected values to be strictly equal:true !== false">
[Error [ERR_TEST_FAILURE]: Expected values to be strictly equal: true !== false]
    </failure>
  </testcase>
  <testcase name="later" classname="test"><skipped type="skipped" message="todo"/></testcase>
</testsuites>`);
    assert.deepEqual(report, {
      total: 3,
      passed: 1,
      failed: 1,
      skipped: 1,
      failures: [
        {
          name: "rejects an empty title",
          classname: "test",
          message: "Expected values to be strictly equal:true !== false",
        },
      ],
    });
  });

  it("reads jest-junit and pytest reports, with entities and CDATA", () => {
    const report = parseJUnit(`<testsuites><testsuite name="api">
  <testcase classname="todos &gt; create" name="returns &quot;201&quot;" time="0.1">
    <failure><![CDATA[Error: expected 201, got 500
    at Object.<anonymous> (todos.test.js:10:5)]]></failure>
  </testcase>
  <testcase classname="tests.test_views.TodoTests" name="test_list"><error message="DatabaseError: no such table"/></testcase>
  <testcase classname="ok" name="fine"></testcase>
</testsuite></testsuites>`);
    assert.equal(report.total, 3);
    assert.equal(report.failed, 2);
    assert.deepEqual(report.failures, [
      { name: 'returns "201"', classname: "todos > create", message: "Error: expected 201, got 500" },
      { name: "test_list", classname: "tests.test_views.TodoTests", message: "DatabaseError: no such table" },
    ]);
  });

  it("finds nothing in something that isn't JUnit", () => {
    assert.equal(parseJUnit("<html><body>nope</body></html>").total, 0);
  });
});
