import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  coverageResult,
  globToRegExp,
  lighthouseResult,
  parseCoveragePy,
  parseLcov,
  staticAnalysisResult,
} from "../harness/lib/quality.mjs";
import { SEMGREP_RULES, semgrepConfig } from "../harness/lib/semgrep-rules.mjs";

describe("globs", () => {
  it("match like the profile's ignore_paths", () => {
    assert.ok(globToRegExp("**/node_modules/**").test("node_modules/x/index.js"));
    assert.ok(globToRegExp("**/node_modules/**").test("backend/node_modules/x.js"));
    assert.ok(globToRegExp("test/**").test("test/app.test.js"));
    assert.ok(!globToRegExp("test/**").test("src/test.js"));
    assert.ok(globToRegExp("**/*.test.js").test("src/a.test.js"));
    assert.ok(!globToRegExp("src/*.js").test("src/lib/a.js"));
  });
});

describe("coverage", () => {
  const lcov = [
    "TN:",
    "SF:/work/src/app.js",
    "DA:1,1",
    "DA:2,0",
    "LF:10",
    "LH:8",
    "end_of_record",
    "SF:/work/src/db.js",
    "DA:1,1",
    "DA:2,0",
    "DA:3,0",
    "DA:4,1",
    "end_of_record",
    "SF:/work/test/app.test.js",
    "LF:20",
    "LH:20",
    "end_of_record",
  ].join("\n");

  it("reads LCOV reports (totals, or line hits when they are missing)", () => {
    assert.deepEqual(parseLcov(lcov), [
      { file: "src/app.js", total: 10, covered: 8 },
      { file: "src/db.js", total: 4, covered: 2 },
      { file: "test/app.test.js", total: 20, covered: 20 },
    ]);
  });

  it("reads coverage.py JSON, relative to where it ran", () => {
    const json = { files: { "notes/views.py": { summary: { num_statements: 30, covered_lines: 27 } } } };
    assert.deepEqual(parseCoveragePy(json, "backend"), [{ file: "backend/notes/views.py", total: 30, covered: 27 }]);
  });

  it("gives partial credit below the target, leaving out excluded files", () => {
    const r = coverageResult(parseLcov(lcov), { target: 80, share: 10, exclude: ["test/**"], command: "npm test" });
    // 10 of 14 lines: 71.4%, so 71.4 / 80 of the credit.
    assert.equal(r.status, "failed");
    assert.equal(r.ratio, 71.4 / 80);
    assert.match(r.message, /71\.4% of the lines \(10 of 14\); the target is 80%/);
    assert.match(r.tests[0].evidence["lowest coverage"], /^ {3}50% {2}src\/db\.js \(2\/4 lines\)/);
    const met = coverageResult(parseLcov(lcov), { target: 70, share: 10, exclude: ["test/**"], command: "npm test" });
    assert.equal(met.status, "passed");
    assert.equal(met.ratio, 1);
  });

  it("fails when nothing was measured", () => {
    const r = coverageResult([], { target: 80, share: 10, command: "npm test" });
    assert.equal(r.ratio, 0);
    assert.equal(r.tests[0].status, "failed");
  });
});

describe("static analysis", () => {
  it("is a valid config of rules with titles, fixes and severities", () => {
    const { rules } = JSON.parse(semgrepConfig());
    assert.ok(rules.length >= 10);
    for (const r of rules) {
      assert.ok(r.metadata.title && r.metadata.fix && r.message, r.id);
      assert.ok(["ERROR", "WARNING", "INFO"].includes(r.severity), r.id);
      assert.equal(new Set(rules.map((x) => x.id)).size, rules.length);
    }
  });

  it("has one test per rule for the repository's languages, failed where it found something", () => {
    const output = {
      paths: { scanned: ["src/app.js", "src/db.js"] },
      results: [
        { check_id: "rules.js-eval", path: "src/app.js", start: { line: 3 }, extra: { lines: "  eval(code)" } },
        { check_id: "rules.js-eval", path: "src/db.js", start: { line: 9 }, extra: { lines: "eval(x)" } },
      ],
    };
    const r = staticAnalysisResult(SEMGREP_RULES, output, { share: 10 });
    const js = SEMGREP_RULES.filter((rule) => rule.languages.includes("javascript"));
    assert.equal(r.tests.length, js.length);
    assert.equal(r.status, "failed");
    assert.equal(r.message, `2 issues found by 1 of ${js.length} rules.`);
    const evalTest = r.tests.find((t) => t.id === "static_analysis.js-eval");
    assert.equal(evalTest.status, "failed");
    assert.equal(evalTest.weight, 3);
    assert.equal(evalTest.evidence.findings, "src/app.js:3  eval(code)\nsrc/db.js:9  eval(x)");
    assert.ok(r.tests.filter((t) => t !== evalTest).every((t) => t.status === "passed"));
  });

  it("passes a repository with nothing to check", () => {
    const r = staticAnalysisResult(SEMGREP_RULES, { paths: { scanned: ["README.md"] }, results: [] }, { share: 5 });
    assert.deepEqual([r.status, r.tests.length], ["passed", 0]);
  });
});

describe("lighthouse", () => {
  const lhr = {
    categories: {
      performance: {
        score: 0.56,
        auditRefs: [
          { id: "lcp", weight: 25 },
          { id: "cls", weight: 25 },
        ],
      },
      accessibility: { score: 0.95, auditRefs: [] },
      "best-practices": { score: 1, auditRefs: [] },
    },
    audits: {
      lcp: { title: "Largest Contentful Paint", score: 0.2, displayValue: "4.1 s" },
      cls: { title: "Cumulative Layout Shift", score: 1 },
    },
  };
  const targets = { performance: 70, accessibility: 90, best_practices: 90 };

  it("scores each category against its target, with the audits to improve", () => {
    const r = lighthouseResult(lhr, { targets, share: 10, url: "http://frontend:3000/" });
    assert.equal(r.status, "failed");
    assert.equal(r.ratio, (56 / 70 + 1 + 1) / 3);
    const perf = r.tests.find((t) => t.id === "lighthouse.performance");
    assert.equal(perf.message, "Scored 56; the target is 70.");
    assert.equal(perf.evidence["audits to improve"], "• Largest Contentful Paint (4.1 s)");
    assert.match(perf.hint, /your front page\/? in Chrome DevTools/);
    assert.equal(r.tests.find((t) => t.id === "lighthouse.best_practices").status, "passed");
  });

  it("fails every category when the page could not load", () => {
    const r = lighthouseResult(
      { runtimeError: { code: "FAILED_DOCUMENT_REQUEST", message: "net::ERR_CONNECTION_REFUSED" } },
      { targets, share: 10, url: "http://frontend:3000/" },
    );
    assert.equal(r.ratio, 0);
    assert.ok(r.tests.every((t) => t.status === "failed"));
    assert.match(r.message, /could not load the page: net::ERR_CONNECTION_REFUSED/);
  });
});
