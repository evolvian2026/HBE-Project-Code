/**
 * A small JUnit XML reader (the harness has no dependencies): enough to tell students which of
 * their own tests failed and why. Handles the reports of node:test, Jest/Vitest (jest-junit),
 * pytest and Django's xmlrunner.
 */

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[e.toLowerCase()] ?? "";
  });

function attributes(source) {
  const out = {};
  for (const m of source.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[m[1]] = decode(m[3] ?? m[4] ?? "");
  return out;
}

const text = (body) =>
  decode(body.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, c) => c.replace(/&/g, "&amp;").replace(/</g, "&lt;"))).trim();

/**
 * @returns {{ total: number, passed: number, failed: number, skipped: number,
 *   failures: { name: string, classname: string, message: string }[] }}
 */
export function parseJUnit(xml) {
  const cases = [];
  for (const m of xml.matchAll(/<testcase\b((?:[^>"']|"[^"]*"|'[^']*')*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attrs = attributes(m[1]);
    const body = m[3] ?? "";
    const failure = body.match(/<(failure|error)\b((?:[^>"']|"[^"]*"|'[^']*')*?)(?:\/>|>([\s\S]*?)<\/\1>)/);
    const skipped = !failure && /<skipped\b/.test(body);
    let message = "";
    if (failure) {
      const detail = text(failure[3] ?? "");
      message = attributes(failure[2]).message || detail.split("\n").find((l) => l.trim()) || failure[1];
    }
    cases.push({
      name: attrs.name ?? "",
      classname: attrs.classname ?? "",
      status: failure ? "failed" : skipped ? "skipped" : "passed",
      message: message.trim(),
    });
  }
  const count = (status) => cases.filter((c) => c.status === status).length;
  return {
    total: cases.length,
    passed: count("passed"),
    failed: count("failed"),
    skipped: count("skipped"),
    failures: cases
      .filter((c) => c.status === "failed")
      .map(({ name, classname, message }) => ({ name, classname, message })),
  };
}
