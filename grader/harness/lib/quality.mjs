/**
 * Turning coverage reports, Semgrep findings and Lighthouse reports into stage results
 * (docs/ARCHITECTURE.md §6.1). Pure functions: the containers that produce the reports are
 * in toolchain.mjs and lighthouse.mjs.
 */
import path from "node:path";

/** A glob (`**`, `*`, `?`) as a regular expression over a relative path with `/` separators. */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      // "**/" matches any number of directories (also none); a trailing "**" anything.
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export const matcher = (globs) => {
  const res = (globs ?? []).map(globToRegExp);
  return (file) => res.some((r) => r.test(file));
};

const pct = (covered, total) => (total === 0 ? 0 : Math.round((covered / total) * 1000) / 10);

/**
 * Line coverage per file from an LCOV report (SF, LF/LH, or DA lines when the totals are
 * missing). Paths are made relative to `base` (the repository inside the container, /work).
 */
export function parseLcov(text, base = "/work") {
  const files = [];
  let current = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("SF:")) current = { file: line.slice(3), total: 0, covered: 0, lf: null, lh: null };
    else if (!current) continue;
    else if (line.startsWith("DA:")) {
      const [, hits] = line.slice(3).split(",");
      current.total += 1;
      if (Number(hits) > 0) current.covered += 1;
    } else if (line.startsWith("LF:")) current.lf = Number(line.slice(3));
    else if (line.startsWith("LH:")) current.lh = Number(line.slice(3));
    else if (line === "end_of_record") {
      const total = Number.isFinite(current.lf) && current.lf !== null ? current.lf : current.total;
      const covered = Number.isFinite(current.lh) && current.lh !== null ? current.lh : current.covered;
      files.push({ file: relative(current.file, base), total, covered });
      current = null;
    }
  }
  return files;
}

/** Line coverage per file from `coverage json` (coverage.py). `dir` is where it ran. */
export function parseCoveragePy(json, dir = "") {
  const data = typeof json === "string" ? JSON.parse(json) : json;
  return Object.entries(data.files ?? {}).map(([file, f]) => ({
    file: path.posix.join(dir, file),
    total: f.summary?.num_statements ?? 0,
    covered: f.summary?.covered_lines ?? 0,
  }));
}

const xmlAttrs = (tag) =>
  Object.fromEntries([...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map((m) => [m[1], m[2].replace(/&amp;/g, "&")]));

/**
 * Line coverage per file from JaCoCo's XML report (Maven, Gradle): each source file's LINE
 * counter, named by its package path (e.g. com/example/notes/NoteController.java).
 */
export function parseJacoco(xml) {
  const files = [];
  for (const pkg of xml.matchAll(/<package\b([^>]*)>([\s\S]*?)<\/package>/g)) {
    const dir = xmlAttrs(pkg[1]).name ?? "";
    for (const src of pkg[2].matchAll(/<sourcefile\b([^>]*)>([\s\S]*?)<\/sourcefile>/g)) {
      const line = /<counter\b[^>]*type="LINE"[^>]*\/>/.exec(src[2]);
      if (!line) continue;
      const c = xmlAttrs(line[0]);
      const missed = Number(c.missed ?? 0);
      const covered = Number(c.covered ?? 0);
      files.push({ file: path.posix.join(dir, xmlAttrs(src[1]).name ?? ""), total: missed + covered, covered });
    }
  }
  return files;
}

/**
 * Line coverage per file from a Cobertura XML report (coverlet for .NET, also Python and PHP
 * tools): lines of every class in a file, joined to the report's first source folder.
 */
export function parseCobertura(xml, base = "/work") {
  const source = /<source>([^<]*)<\/source>/.exec(xml)?.[1]?.trim() ?? "";
  const lines = new Map();
  for (const cls of xml.matchAll(/<class\b([^>]*)>([\s\S]*?)<\/class>/g)) {
    const name = xmlAttrs(cls[1]).filename;
    if (!name) continue;
    const file = relative(name.startsWith("/") ? name : path.posix.join(source || "/", name), base);
    const seen = lines.get(file) ?? new Map();
    for (const l of cls[2].matchAll(/<line\b([^>]*?)\/?>/g)) {
      const a = xmlAttrs(l[1]);
      if (a.number === undefined) continue;
      seen.set(a.number, (seen.get(a.number) ?? false) || Number(a.hits ?? 0) > 0);
    }
    lines.set(file, seen);
  }
  return [...lines].map(([file, seen]) => ({
    file,
    total: seen.size,
    covered: [...seen.values()].filter(Boolean).length,
  }));
}

/** Statement coverage per file from a Clover XML report (PHPUnit's --coverage-clover). */
export function parseClover(xml, base = "/work") {
  const files = [];
  for (const f of xml.matchAll(/<file\b([^>]*)>([\s\S]*?)<\/file>/g)) {
    const name = xmlAttrs(f[1]).name;
    const metrics = /<metrics\b([^>]*)\/>/.exec(f[2]);
    if (!name || !metrics) continue;
    const m = xmlAttrs(metrics[1]);
    files.push({
      file: relative(name, base),
      total: Number(m.statements ?? 0),
      covered: Number(m.coveredstatements ?? 0),
    });
  }
  return files;
}

/** A coverage report in one of the formats stack profiles name, as lines per file. */
export function parseCoverage(format, text, reportPath) {
  const dir = path.posix.dirname(reportPath);
  switch (format) {
    case "coverage-py":
      return parseCoveragePy(text, dir === "." ? "" : dir).map((f) => ({ ...f, file: relative(f.file, "/work") }));
    case "jacoco":
      return parseJacoco(text);
    case "cobertura":
      return parseCobertura(text);
    case "clover":
      return parseClover(text);
    default:
      return parseLcov(text, "/work");
  }
}

function relative(file, base) {
  const f = file.replace(/\\/g, "/");
  if (f.startsWith(`${base}/`)) return f.slice(base.length + 1);
  return f.replace(/^\.\//, "");
}

/**
 * The coverage stage: one test (met the target or not) and partial credit for getting part of
 * the way there. `files` come from the report; `exclude` drops test files and the like.
 */
export function coverageResult(files, { target, share, exclude, command }) {
  const skip = matcher(exclude);
  const counted = files.filter((f) => !skip(f.file) && f.total > 0);
  const total = counted.reduce((s, f) => s + f.total, 0);
  const covered = counted.reduce((s, f) => s + f.covered, 0);
  const percent = pct(covered, total);
  const met = total > 0 && percent >= target;
  const lowest = [...counted]
    .sort((a, b) => a.covered / a.total - b.covered / b.total || b.total - a.total)
    .slice(0, 15)
    .map((f) => `${String(pct(f.covered, f.total)).padStart(5)}%  ${f.file} (${f.covered}/${f.total} lines)`);
  const message =
    total === 0
      ? "The coverage report measured no code."
      : `Your tests cover ${percent}% of the lines (${covered} of ${total}); the target is ${target}%.`;
  return {
    status: met ? "passed" : "failed",
    share,
    ratio: total === 0 ? 0 : Math.min(1, percent / target),
    message,
    tests: [
      {
        id: "coverage",
        title: `Your tests cover at least ${target}% of the code`,
        category: "Your tests",
        weight: 1,
        status: met ? "passed" : "failed",
        message,
        hint: met
          ? undefined
          : `Run \`${command}\` on your computer and add tests for the files with the lowest coverage.`,
        ...(lowest.length ? { evidence: { "lowest coverage": lowest.join("\n") } } : {}),
      },
    ],
  };
}

const SEVERITY_WEIGHT = { ERROR: 3, WARNING: 2, INFO: 1 };
const EXTENSION_LANGUAGES = {
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".py": "python",
  ".java": "java",
  ".cs": "csharp",
  ".php": "php",
};

/** The languages of the files Semgrep scanned (for which rules apply). */
export function languagesOf(files) {
  return new Set(files.map((f) => EXTENSION_LANGUAGES[path.extname(f).toLowerCase()]).filter(Boolean));
}

/**
 * The static analysis stage: one test per rule that applies to the repository's languages,
 * failed when the rule found anything, weighted by its severity. `source(path, line)` gives
 * the line of code to quote (Semgrep doesn't include it without a Semgrep account).
 */
export function staticAnalysisResult(rules, output, { share, source = () => "" }) {
  const scanned = output.paths?.scanned ?? [];
  const languages = languagesOf(scanned);
  const findings = new Map();
  for (const r of output.results ?? []) {
    // Semgrep prefixes rule ids with the config file's path.
    const id = String(r.check_id ?? "")
      .split(".")
      .pop();
    if (!findings.has(id)) findings.set(id, []);
    findings.get(id).push(r);
  }
  const applicable = rules.filter((rule) => rule.languages.some((l) => languages.has(l)));
  const tests = applicable.map((rule) => {
    const found = findings.get(rule.id) ?? [];
    const lines = found.slice(0, 20).map((f) => {
      const quoted =
        f.extra?.lines && f.extra.lines !== "requires login" ? f.extra.lines : source(f.path, f.start?.line);
      return `${f.path}:${f.start?.line ?? "?"}  ${String(quoted ?? "")
        .trim()
        .slice(0, 160)}`;
    });
    if (found.length > 20) lines.push(`…and ${found.length - 20} more`);
    return {
      id: `static_analysis.${rule.id}`,
      title: rule.metadata.title,
      category: rule.metadata.category,
      weight: SEVERITY_WEIGHT[rule.severity] ?? 1,
      status: found.length ? "failed" : "passed",
      ...(found.length
        ? {
            message: `${found.length} ${found.length === 1 ? "place" : "places"}: ${rule.message}`,
            hint: rule.metadata.fix,
            evidence: { findings: lines.join("\n") },
          }
        : {}),
    };
  });
  const issues = tests.filter((t) => t.status === "failed");
  const count = applicable.reduce((s, rule) => s + (findings.get(rule.id)?.length ?? 0), 0);
  return {
    status: issues.length ? "failed" : "passed",
    share,
    message:
      tests.length === 0
        ? "No JavaScript, TypeScript, Python, Java, C# or PHP files to check."
        : issues.length
          ? `${count} ${count === 1 ? "issue" : "issues"} found by ${issues.length} of ${tests.length} rules.`
          : `No issues found by ${tests.length} rules.`,
    tests,
  };
}

export const LIGHTHOUSE_CATEGORIES = {
  performance: { id: "performance", title: "Performance" },
  accessibility: { id: "accessibility", title: "Accessibility" },
  best_practices: { id: "best-practices", title: "Best practices" },
};

/**
 * The Lighthouse stage: one test per category (its score against the assignment's target)
 * and partial credit for the share of each target reached. `lhr` is Lighthouse's JSON report.
 */
export function lighthouseResult(lhr, { targets, share, url }) {
  const failedRun = lhr.runtimeError?.code && lhr.runtimeError.code !== "NO_ERROR";
  const ratios = [];
  const tests = Object.entries(LIGHTHOUSE_CATEGORIES).map(([key, cat]) => {
    const target = targets[key];
    const category = lhr.categories?.[cat.id];
    const score = typeof category?.score === "number" ? Math.round(category.score * 100) : null;
    ratios.push(score === null ? 0 : Math.min(1, score / target));
    const met = score !== null && score >= target;
    const weak = (category?.auditRefs ?? [])
      .filter((ref) => ref.weight > 0)
      .map((ref) => ({ ref, audit: lhr.audits?.[ref.id] }))
      .filter(({ audit }) => audit && typeof audit.score === "number" && audit.score < 0.9)
      .sort((a, b) => b.ref.weight * (1 - b.audit.score) - a.ref.weight * (1 - a.audit.score))
      .slice(0, 10)
      .map(({ audit }) => `• ${audit.title}${audit.displayValue ? ` (${audit.displayValue})` : ""}`);
    const message =
      score === null
        ? `Lighthouse could not score ${cat.title.toLowerCase()}${failedRun ? `: ${lhr.runtimeError.message}` : "."}`
        : `Scored ${score}; the target is ${target}.`;
    return {
      id: `lighthouse.${key}`,
      title: `${cat.title} score is at least ${target}`,
      category: "Lighthouse",
      weight: 1,
      status: met ? "passed" : "failed",
      message,
      ...(met
        ? {}
        : {
            hint: `Run Lighthouse on ${url.replace(/^http:\/\/[^/]+/, "your front page")} in Chrome DevTools (Lighthouse tab) and fix what it lists.`,
          }),
      ...(weak.length && !met ? { evidence: { "audits to improve": weak.join("\n") } } : {}),
    };
  });
  return {
    status: tests.every((t) => t.status === "passed") ? "passed" : "failed",
    share,
    ratio: ratios.reduce((s, r) => s + r, 0) / ratios.length,
    ...(failedRun ? { message: `Lighthouse could not load the page: ${lhr.runtimeError.message}` } : {}),
    tests,
  };
}
