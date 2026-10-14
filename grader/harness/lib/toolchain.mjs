/**
 * The stages that work on the repository rather than the running app (docs/ARCHITECTURE.md
 * §6.1): the stack profile's lint, the student's tests and their coverage, and the platform's
 * static analysis (Semgrep, offline, with the rules in semgrep-rules.mjs).
 *
 * Each runs in a fresh container of the stage's `image`, on a Docker volume holding a copy of
 * the student's repository (never the suite, never a host mount), with memory, CPU and process
 * limits and a minimal environment. `setup` (installing dependencies) runs once per image and
 * setup command; it has internet access, like the build. What it installs must outlive its
 * container: npm installs into the repository copy (node_modules), and pip into a second volume
 * mounted at /opt/hbe-tools (PIP_USER, PYTHONUSERBASE; its bin directory is on PATH). A stage
 * passes when its command exits 0 and, for `report: junit`, the JUnit file lists no failures.
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { looksLikeInfraFailure, run } from "./exec.mjs";
import { parseJUnit } from "./junit.mjs";
import { coverageResult, parseCoveragePy, parseLcov, staticAnalysisResult } from "./quality.mjs";
import { SEMGREP_RULES, semgrepConfig } from "./semgrep-rules.mjs";

/** Semgrep, pinned: a new version can find different things, which changes grades. */
export const SEMGREP_IMAGE = "semgrep/semgrep:1.177.0";
/**
 * Never scanned (gitignore syntax): dependencies, build output, and tests (whose fixtures may
 * hold made-up secrets). The profile's ignore_paths are added; the student's own
 * .semgrepignore files are removed, and `nosemgrep` comments are ignored.
 */
const SEMGREP_IGNORE = [
  ".git/",
  "node_modules/",
  "dist/",
  "build/",
  "vendor/",
  ".venv/",
  "venv/",
  "__pycache__/",
  "test/",
  "tests/",
  "__tests__/",
  "*.test.*",
  "*.spec.*",
  "test_*.py",
  "*.min.js",
  ".hbe-*",
];
const shellQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

const LIMITS = ["--memory", "2g", "--pids-limit", "1024", "--cpus", "2"];
const TOOLS = "/opt/hbe-tools";
const ENV = ["CI=true", "HOME=/tmp", "PIP_USER=1", `PYTHONUSERBASE=${TOOLS}/python`, "PIP_DISABLE_PIP_VERSION_CHECK=1"];
const tail = (s, n) => s.trimEnd().split("\n").slice(-n).join("\n");

const LABELS = {
  lint: (def) => ({
    title: `Lint passes (${def.run})`,
    category: "Code quality",
    hint: `Run \`${def.run}\` on your computer and fix what it reports.`,
  }),
  student_tests: (def) => ({
    title: `Your own tests pass (${def.run})`,
    category: "Your tests",
    hint: `Run \`${def.run}\` on your computer: every test should pass, and the command should exit with code 0.`,
  }),
};

/**
 * @param {{ project: string, submissionDir: string, workdir: string,
 *   remaining: (maxMs: number) => number, infra: (message: string) => never,
 *   keep: (name: string, source: { text?: string, file?: string }) => void }} ctx
 *   `keep` saves a file to upload with the results (the full output, the JUnit report).
 */
export function createToolchains({ project, submissionDir, workdir, remaining, infra, keep }) {
  const prepared = new Map();
  const volumes = [];
  let seq = 0;

  /** Runs `command` in a fresh container on the volume; the container is always removed. */
  async function sandbox(volume, image, command, timeoutMs, extra = []) {
    const name = `${project}-tc${++seq}`;
    const r = await run(
      "docker",
      [
        "run",
        "--name",
        name,
        "-v",
        `${volume}:/work`,
        "-v",
        `${volume}-tools:${TOOLS}`,
        "-w",
        "/work",
        ...LIMITS,
        ...ENV.flatMap((e) => ["-e", e]),
        ...extra,
        "--entrypoint",
        "sh",
        image,
        "-c",
        `export PATH="${TOOLS}/python/bin:$PATH"; ${command}`,
      ],
      { timeoutMs, maxOutput: 256 * 1024 },
    );
    await run("docker", ["rm", "-f", name], { timeoutMs: 30_000 });
    return { ...r, output: `${r.stdout}${r.stderr}` };
  }

  async function prepareVolume(def) {
    const volume = `${project}-vol${volumes.length}`;
    volumes.push(volume, `${volume}-tools`);
    // Pull only when missing: runners with a warm cache skip the registry (and its rate limits).
    const present = await run("docker", ["image", "inspect", def.image], { timeoutMs: 30_000 });
    if (present.code !== 0) {
      const pull = await run("docker", ["pull", "-q", def.image], { timeoutMs: remaining(5 * 60_000) });
      if (pull.code !== 0) infra(`Could not pull ${def.image}: ${tail(pull.stderr, 3)}`);
    }
    await run("docker", ["volume", "create", volume], { timeoutMs: 30_000 });
    const holder = `${volume}-copy`;
    await run("docker", ["create", "--name", holder, "-v", `${volume}:/work`, def.image], { timeoutMs: 30_000 });
    const cp = await run("docker", ["cp", `${submissionDir}/.`, `${holder}:/work`], { timeoutMs: 180_000 });
    await run("docker", ["rm", "-f", holder], { timeoutMs: 30_000 });
    if (cp.code !== 0) infra(`Could not copy the repository into the ${def.image} container: ${tail(cp.stderr, 3)}`);
    const setup = def.setup
      ? await sandbox(volume, def.image, def.setup, remaining(8 * 60_000))
      : { code: 0, output: "", timedOut: false };
    if (setup.code !== 0 && looksLikeInfraFailure(setup.output)) {
      infra(`Installing dependencies failed for a platform reason: ${tail(setup.output, 5)}`);
    }
    return { volume, setup };
  }

  /** The repository copy (with dependencies installed) for this image and setup command. */
  function prepare(def) {
    const key = `${def.image}\n${def.setup ?? ""}`;
    if (!prepared.has(key)) prepared.set(key, prepareVolume(def));
    return prepared.get(key);
  }

  /** Copies a file out of the volume; null when it is missing or larger than `maxBytes`. */
  async function copyOut(volume, image, file, maxBytes) {
    const holder = `${project}-out${++seq}`;
    const local = path.join(workdir, `out-${seq}-${path.basename(file)}`);
    await run("docker", ["create", "--name", holder, "-v", `${volume}:/work`, image], { timeoutMs: 30_000 });
    const cp = await run("docker", ["cp", "-L", `${holder}:/work/${file}`, local], { timeoutMs: 60_000 });
    await run("docker", ["rm", "-f", holder], { timeoutMs: 30_000 });
    try {
      return cp.code === 0 && statSync(local).isFile() && statSync(local).size <= maxBytes ? local : null;
    } catch {
      return null;
    }
  }

  async function readJUnit(volume, image, file) {
    const local = await copyOut(volume, image, file, 5 * 1024 * 1024);
    if (!local) return null;
    try {
      const report = parseJUnit(readFileSync(local, "utf8"));
      return report.total > 0 ? { ...report, file: local } : null;
    } catch {
      return null;
    }
  }

  /**
   * Runs one profile stage. Returns the stage result: one test (so the run page and the check
   * run show it like any other), worth the assignment's share of the automated score.
   */
  async function runStage(key, def, share) {
    const label = LABELS[key](def);
    const started = Date.now();
    const result = (passed, message, evidence) => ({
      status: passed ? "passed" : "failed",
      share,
      tests: [
        {
          id: key,
          ...label,
          weight: 1,
          status: passed ? "passed" : "failed",
          duration_ms: Date.now() - started,
          ...(message ? { message } : {}),
          ...(evidence ? { evidence } : {}),
        },
      ],
    });

    const { volume, setup } = await prepare(def);
    if (setup.code !== 0) {
      return result(
        false,
        setup.timedOut
          ? `Installing dependencies (\`${def.setup}\`) took too long.`
          : `Installing dependencies failed (\`${def.setup}\`), so \`${def.run}\` could not run.`,
        { output: tail(setup.output, 60) },
      );
    }

    const limit = remaining(8 * 60_000);
    const r = await sandbox(volume, def.image, def.run, limit);
    if (r.code !== 0 && !r.timedOut && looksLikeInfraFailure(r.output)) {
      infra(`${key} failed for a platform reason: ${tail(r.output, 5)}`);
    }
    keep(`${key}/output.log`, { text: r.output });
    const junit = def.report === "junit" && def.junit ? await readJUnit(volume, def.image, def.junit) : null;
    if (junit) keep(`${key}/junit.xml`, { file: junit.file });
    const passed = r.code === 0 && !(junit && junit.failed > 0);
    const evidence = { output: tail(r.output, 60) };
    if (junit?.failures.length) {
      evidence.failures = junit.failures
        .slice(0, 30)
        .map((f) => `✗ ${[f.classname, f.name].filter(Boolean).join(" › ")}${f.message ? `\n  ${f.message}` : ""}`)
        .join("\n");
    }
    if (passed) return result(true, junit ? `${junit.passed} of ${junit.total} tests passed.` : undefined);
    const message = r.timedOut
      ? `\`${def.run}\` did not finish within ${Math.round(limit / 60_000)} minutes.`
      : junit && junit.failed > 0
        ? `${junit.failed} of ${junit.total} tests failed.`
        : `\`${def.run}\` exited with code ${r.code}.`;
    return result(false, message, evidence);
  }

  /**
   * Line coverage of the student's tests (the profile's `coverage` stage): its command writes a
   * report, the harness reads it. Full credit at the assignment's target, partial below it.
   */
  async function runCoverage(def, { share, target }) {
    const started = Date.now();
    const failed = (message, evidence) => ({
      status: "failed",
      share,
      ratio: 0,
      message,
      tests: [
        {
          id: "coverage",
          title: `Your tests cover at least ${target}% of the code`,
          category: "Your tests",
          weight: 1,
          status: "failed",
          duration_ms: Date.now() - started,
          message,
          hint: `Run \`${def.run}\` on your computer: your tests should pass and the report should be written to ${def.file}.`,
          ...(evidence ? { evidence } : {}),
        },
      ],
    });

    const { volume, setup } = await prepare(def);
    if (setup.code !== 0) {
      return failed(`Installing dependencies failed (\`${def.setup}\`), so coverage could not be measured.`, {
        output: tail(setup.output, 60),
      });
    }
    const limit = remaining(8 * 60_000);
    const r = await sandbox(volume, def.image, def.run, limit);
    if (r.code !== 0 && !r.timedOut && looksLikeInfraFailure(r.output)) {
      infra(`coverage failed for a platform reason: ${tail(r.output, 5)}`);
    }
    keep("coverage/output.log", { text: r.output });
    if (r.timedOut) return failed(`\`${def.run}\` did not finish within ${Math.round(limit / 60_000)} minutes.`);
    const local = await copyOut(volume, def.image, def.file, 20 * 1024 * 1024);
    if (!local) {
      return failed(
        `\`${def.run}\` wrote no coverage report to ${def.file}${r.code ? ` (it exited with code ${r.code})` : ""}.`,
        { output: tail(r.output, 60) },
      );
    }
    let files;
    try {
      const text = readFileSync(local, "utf8");
      const dir = path.posix.dirname(def.file);
      files =
        def.format === "coverage-py"
          ? parseCoveragePy(text, dir === "." ? "" : dir).map((f) => ({ ...f, file: f.file.replace(/^\/work\//, "") }))
          : parseLcov(text, "/work");
    } catch {
      return failed(`The coverage report (${def.file}) could not be read.`);
    }
    keep(`coverage/${path.basename(def.file)}`, { file: local });
    const outcome = coverageResult(files, { target, share, exclude: def.exclude, command: def.run });
    outcome.tests[0].duration_ms = Date.now() - started;
    return outcome;
  }

  /** A line of the student's code, for quoting a finding (never outside the checkout). */
  function lineOf(file, line) {
    const full = path.resolve(submissionDir, String(file));
    if (!full.startsWith(`${submissionDir}${path.sep}`) || !Number.isInteger(line)) return "";
    try {
      if (statSync(full).size > 2 * 1024 * 1024) return "";
      return readFileSync(full, "utf8").split("\n")[line - 1] ?? "";
    } catch {
      return "";
    }
  }

  /** The platform's Semgrep rules over the repository, without network access. */
  async function runStaticAnalysis({ share }, ignorePaths = []) {
    const def = { image: SEMGREP_IMAGE };
    const rules = path.join(workdir, "semgrep-rules.yml");
    writeFileSync(rules, semgrepConfig());
    const { volume } = await prepare(def);
    const ignore = [...SEMGREP_IGNORE, ...ignorePaths].map(shellQuote).join(" ");
    const command = [
      "find . -name .semgrepignore -not -path './.git/*' -delete",
      `printf '%s\\n' ${ignore} > .semgrepignore`,
      "semgrep scan --config /rules/semgrep.yml --json --output .hbe-semgrep.json --metrics=off" +
        " --disable-version-check --disable-nosem --quiet --timeout 30 --max-target-bytes 1000000 --jobs 2 .",
    ].join("; ");
    const r = await sandbox(volume, SEMGREP_IMAGE, command, remaining(6 * 60_000), [
      "--network",
      "none",
      "-v",
      `${rules}:/rules/semgrep.yml:ro`,
    ]);
    const local = await copyOut(volume, SEMGREP_IMAGE, ".hbe-semgrep.json", 20 * 1024 * 1024);
    let output;
    try {
      output = local ? JSON.parse(readFileSync(local, "utf8")) : null;
    } catch {
      output = null;
    }
    if (!output) infra(`Static analysis could not run: ${tail(r.output, 5)}`);
    keep("static_analysis/semgrep.json", { file: local });
    return staticAnalysisResult(SEMGREP_RULES, output, { share, source: (file, line) => lineOf(file, line) });
  }

  async function cleanup() {
    for (const volume of volumes) await run("docker", ["volume", "rm", "-f", volume], { timeoutMs: 60_000 });
  }

  return { runStage, runCoverage, runStaticAnalysis, cleanup };
}
