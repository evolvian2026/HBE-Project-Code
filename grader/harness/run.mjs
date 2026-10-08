#!/usr/bin/env node
/**
 * The grader harness: evaluates one student commit and reports the results to the platform.
 *
 *   node harness/run.mjs --run-id <uuid> --sha <sha> --submission <dir> --suite <dir>
 *     --profile '<stack profile JSON>' --api-url <url> [--token <token>] [--out results.json]
 *     [--timeout-minutes 20] [--no-callback] [--keep]
 *
 * Stages: contract → lint → student tests → build → health → the suite's test stages
 * (docs/ARCHITECTURE.md §6). Lint and student tests run when the assignment turns them on
 * (`options` in the profile JSON) and the profile defines them; the assignment can also turn
 * off hidden-test stages by kind (`api`, `browser`).
 * The student's app runs with Docker Compose on an internal network with no internet access;
 * the hidden tests run in a separate container on that network, so the app never sees them.
 * Failures caused by the platform (Docker Hub limits, a full disk, a broken suite) are
 * reported as `infra_error`: the run is not graded.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createCallbacks } from "./lib/callback.mjs";
import { prepareCompose, redact } from "./lib/compose.mjs";
import { looksLikeInfraFailure, run } from "./lib/exec.mjs";
import { createToolchains } from "./lib/toolchain.mjs";

const RUNNER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "runner");
const TESTER_IMAGE = process.env.HBE_TESTER_IMAGE ?? "node:22-bookworm-slim";
/** Browser stages: Playwright's image plus playwright-core (harness/browser/Dockerfile). */
const BROWSER_IMAGE = "hbe-browser-tester:1.56.1";
const BROWSER_DOCKERFILE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "browser");
const COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];
const GATING = ["contract", "build", "health"];

class InfraError extends Error {}

const log = (message) => console.log(`[hbe] ${message}`);
const clip = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s);
const tailLines = (s, n) => s.trimEnd().split("\n").slice(-n).join("\n");

const { values: args } = parseArgs({
  options: {
    "run-id": { type: "string" },
    sha: { type: "string" },
    submission: { type: "string" },
    suite: { type: "string" },
    profile: { type: "string" },
    "api-url": { type: "string" },
    token: { type: "string" },
    "no-callback": { type: "boolean", default: false },
    out: { type: "string", default: "results.json" },
    "timeout-minutes": { type: "string", default: "20" },
    keep: { type: "boolean", default: false },
  },
});

for (const required of ["run-id", "submission", "suite", "profile"]) {
  if (!args[required]) {
    console.error(`Missing --${required}`);
    process.exit(2);
  }
}
if (!args["no-callback"] && !args["api-url"]) {
  console.error("Missing --api-url (or pass --no-callback)");
  process.exit(2);
}

const runId = args["run-id"];
const submissionDir = path.resolve(args.submission);
const suiteDir = path.resolve(args.suite);
const profile = JSON.parse(args.profile);
const options = { stages: {}, skip_kinds: [], ...(profile.options ?? {}) };
const manifest = JSON.parse(readFileSync(path.join(suiteDir, "suite.json"), "utf8"));
const project = `hbe-${runId
  .replace(/[^a-z0-9]/gi, "")
  .slice(0, 12)
  .toLowerCase()}-${randomBytes(3).toString("hex")}`;
const network = `${project}-net`;
const deadline = Date.now() + Number(args["timeout-minutes"]) * 60_000 - 90_000; // leave time to report
const remaining = (max) => Math.max(10_000, Math.min(max, deadline - Date.now()));
const serviceUrls = Object.fromEntries(
  Object.entries(profile.services ?? {}).map(([name, spec]) => [name, `http://${name}:${spec.port}`]),
);
const secrets = [];

const token = args.token ?? process.env.HBE_CALLBACK_TOKEN;
delete process.env.HBE_CALLBACK_TOKEN;
if (token && process.env.GITHUB_ACTIONS === "true") console.log(`::add-mask::${token}`);
const callbacks = args["no-callback"] ? null : createCallbacks({ apiUrl: args["api-url"], runId, token });
delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;

const results = {
  run_id: runId,
  sha: args.sha ?? "",
  stack_profile: `${profile.key ?? "custom"}@${profile.version ?? 0}`,
  suite_version: `${manifest.key}@${manifest.version}`,
  started_at: new Date().toISOString(),
  finished_at: "",
  infra_error: null,
  stages: [],
};

let composePath = null;
const workdir = mkdtempSync(path.join(tmpdir(), "hbe-run-"));
const compose = (...rest) => ["compose", "-p", project, "-f", composePath, ...rest];
const toolchains = createToolchains({
  project,
  submissionDir,
  workdir,
  remaining,
  infra: (message) => {
    throw new InfraError(message);
  },
});

async function stage(key, fn) {
  const started = Date.now();
  log(`${key}: running`);
  const outcome = await fn();
  results.stages.push({ key, duration_ms: Date.now() - started, ...outcome });
  log(`${key}: ${outcome.status}`);
  return outcome.status === "passed";
}

/** A container on the app's network that runs the probes and hidden tests. */
function tester(mode, config, timeoutMs, { outDir } = {}) {
  // Browser tests write screenshots and traces to outDir, as the runner's own user so the
  // harness can read and delete them.
  const browser = Boolean(outDir);
  return run(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      network,
      "--memory",
      browser ? "2g" : "512m",
      "--pids-limit",
      browser ? "1024" : "256",
      ...(browser ? ["--shm-size", "1g", "--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`] : []),
      ...(browser ? ["-e", "HOME=/tmp", "-v", `${outDir}:/out`] : []),
      "-v",
      `${RUNNER_DIR}:/runner:ro`,
      ...(mode === "tests" ? ["-v", `${suiteDir}:/suite:ro`] : []),
      "-e",
      `HBE_RUNNER_CONFIG=${JSON.stringify(config)}`,
      browser ? BROWSER_IMAGE : TESTER_IMAGE,
      "node",
      "/runner/run-tests.mjs",
      mode,
    ],
    { timeoutMs, maxOutput: 4 * 1024 * 1024 },
  );
}

/** Builds the browser tester image unless this runner already has it. */
async function ensureBrowserImage() {
  if ((await run("docker", ["image", "inspect", BROWSER_IMAGE], { timeoutMs: 30_000 })).code === 0) return;
  log(`building ${BROWSER_IMAGE}`);
  const r = await run("docker", ["build", "-t", BROWSER_IMAGE, BROWSER_DOCKERFILE_DIR], {
    timeoutMs: remaining(15 * 60_000),
    maxOutput: 64 * 1024,
  });
  if (r.code !== 0) throw new InfraError(`Could not build the browser test image: ${tailLines(r.stderr, 5)}`);
}

/** Files to upload with the results (screenshots and traces of failed browser tests). */
const artifacts = [];

async function serviceLogs(services) {
  const r = await run("docker", compose("logs", "--no-color", "--tail", "80", ...services), { timeoutMs: 30_000 });
  return redact(tailLines(`${r.stdout}${r.stderr}`, 80), secrets).slice(-4000);
}

function infraCheck(output, what) {
  if (looksLikeInfraFailure(output))
    throw new InfraError(`${what} failed for a platform reason: ${tailLines(output, 5)}`);
}

async function contract() {
  const problems = (profile.detect ?? [])
    .filter((f) => !existsSync(path.join(submissionDir, f)))
    .map((f) => `Missing ${f}: the ${profile.key ?? "assignment's"} stack expects it at the top of your repository.`);
  const composeFile = COMPOSE_FILES.find((f) => existsSync(path.join(submissionDir, f)));
  if (!composeFile && !problems.some((p) => p.includes("compose"))) {
    problems.push("Missing compose.yaml: the grader starts your app with Docker Compose.");
  }
  if (problems.length) return { status: "failed", message: problems.join("\n") };

  const cfg = await run(
    "docker",
    ["compose", "-f", composeFile, "--project-directory", submissionDir, "config", "--format", "json"],
    { cwd: submissionDir, timeoutMs: 60_000, maxOutput: 1024 * 1024 },
  );
  if (cfg.code !== 0) {
    infraCheck(cfg.stderr, "Reading the compose file");
    if (cfg.code === -1) throw new InfraError(`Docker Compose is not available: ${cfg.stderr}`);
    return { status: "failed", message: `${composeFile} is not valid:\n${tailLines(cfg.stderr, 10)}` };
  }
  const prepared = prepareCompose(JSON.parse(cfg.stdout), profile, { submissionDir, project });
  if (prepared.problems.length) return { status: "failed", message: prepared.problems.join("\n") };
  secrets.push(...prepared.secrets);
  if (process.env.GITHUB_ACTIONS === "true") for (const s of prepared.secrets) console.log(`::add-mask::${s}`);
  composePath = path.join(workdir, "compose.json");
  writeFileSync(composePath, JSON.stringify(prepared.config, null, 2));
  return { status: "passed" };
}

async function build() {
  const limit = remaining(10 * 60_000);
  const r = await run("docker", compose("build"), { timeoutMs: limit, maxOutput: 256 * 1024 });
  const output = `${r.stdout}${r.stderr}`;
  console.log(tailLines(output, 40));
  if (r.code === 0) return { status: "passed" };
  if (r.timedOut)
    return { status: "failed", message: `The build took longer than ${Math.round(limit / 60_000)} minutes.` };
  infraCheck(output, "The build");
  return {
    status: "failed",
    message: `The build failed. The end of the build output:\n\n${clip(redact(tailLines(output, 40), secrets), 3500)}`,
  };
}

async function health() {
  const up = await run("docker", compose("up", "-d", "--no-build"), { timeoutMs: remaining(5 * 60_000) });
  if (up.code !== 0) {
    infraCheck(`${up.stdout}${up.stderr}`, "Starting the app");
    return {
      status: "failed",
      message: `Your app's containers could not start:\n${clip(redact(tailLines(up.stderr, 20), secrets), 3500)}`,
    };
  }
  const targets = Object.entries(profile.services ?? {}).map(([service, spec]) => ({
    service,
    url: `http://${service}:${spec.port}${spec.health ?? "/"}`,
  }));
  const probe = await tester("health", { targets, timeoutMs: 120_000 }, remaining(4 * 60_000));
  if (probe.code !== 0) {
    infraCheck(probe.stderr, "Starting the test container");
    throw new InfraError(`The health probe could not run: ${tailLines(probe.stderr, 5)}`);
  }
  const outcome = JSON.parse(probe.stdout);
  if (outcome.ok) return { status: "passed" };
  const down = outcome.results.filter((r) => !r.ok);
  const lines = down.map((r) => {
    const spec = profile.services[r.service];
    return `"${r.service}" did not answer GET ${spec.health ?? "/"} on port ${spec.port} within 2 minutes (last result: ${r.last}).`;
  });
  const logs = await serviceLogs(down.map((r) => r.service));
  return {
    status: "failed",
    message: clip(`${lines.join("\n")}\n\nRecent logs:\n${logs || "(no output)"}`, 3800),
  };
}

const textFields = {
  title: 200,
  category: 80,
  expected: 1500,
  actual: 1500,
  message: 3000,
  hint: 1000,
  staff_notes: 2000,
};
function cleanTest(test, logs) {
  const out = { ...test };
  for (const [field, max] of Object.entries(textFields)) {
    if (typeof out[field] === "string") out[field] = clip(redact(out[field], secrets), max);
  }
  const failed = out.status === "failed" || out.status === "error";
  if (out.evidence || (failed && logs)) {
    out.evidence = Object.fromEntries(
      Object.entries({ ...(out.evidence ?? {}), ...(failed && logs ? { logs } : {}) }).map(([k, v]) => [
        k,
        clip(redact(String(v), secrets), 6000),
      ]),
    );
  }
  return out;
}

async function listTests(file) {
  const suite = (await import(pathToFileURL(path.join(suiteDir, file)).href)).default;
  return suite.tests.map((t) => ({
    id: t.id,
    title: t.title,
    category: t.category,
    weight: t.weight ?? 1,
    hint: t.hint,
  }));
}

async function testStage(def) {
  const browser = (def.kind ?? "api") === "browser";
  let outDir;
  const config = { suiteFile: `/suite/${def.file}`, services: serviceUrls, testTimeoutMs: browser ? 45_000 : 20_000 };
  if (browser) {
    await ensureBrowserImage();
    outDir = path.join(workdir, `out-${def.key}`);
    mkdirSync(outDir, { recursive: true });
    const names = Object.keys(profile.services ?? {});
    config.browser = { service: names.includes("frontend") ? "frontend" : names[0] };
  }
  const limit = remaining(10 * 60_000);
  const r = await tester("tests", config, limit, { outDir });
  if (r.timedOut) {
    const tests = (await listTests(def.file)).map((t) => ({
      ...t,
      status: "failed",
      message: "The tests did not finish in time; your app may be hanging.",
    }));
    return {
      status: "failed",
      message: `The tests did not finish within ${Math.round(limit / 60_000)} minutes.`,
      tests,
    };
  }
  if (r.code !== 0) {
    infraCheck(r.stderr, "The test container");
    throw new InfraError(`The test runner failed: ${tailLines(r.stderr, 5)}`);
  }
  const raw = JSON.parse(r.stdout);
  const anyFailed = raw.some((t) => t.status === "failed" || t.status === "error");
  const logs = anyFailed ? await serviceLogs(Object.keys(profile.services ?? {})) : "";
  const tests = raw.map((t) => {
    const cleaned = cleanTest(t, logs);
    if (!t.attachments) return cleaned;
    // Screenshot and trace files, uploaded with the results as <stage>/<file>.
    const attachments = {};
    for (const [kind, file] of Object.entries(t.attachments)) {
      const local = path.join(outDir ?? "", path.basename(file));
      if (!outDir || !existsSync(local)) continue;
      attachments[kind] = `${def.key}/${path.basename(file)}`;
      artifacts.push({ name: attachments[kind], file: local });
    }
    return Object.keys(attachments).length ? { ...cleaned, attachments } : cleaned;
  });
  if (tests.some((t) => t.status === "error")) {
    log(
      `suite errors: ${tests
        .filter((t) => t.status === "error")
        .map((t) => t.id)
        .join(", ")}`,
    );
  }
  return { status: anyFailed ? "failed" : "passed", tests };
}

/**
 * Graded runs archive the commit (FR-9.1): a git bundle (history up to the commit) and a
 * tarball of the tree, uploaded to signed URLs from the platform. Failures are logged and
 * don't stop grading.
 */
async function snapshot() {
  if (!callbacks) return;
  let targets;
  try {
    targets = await callbacks.snapshotUploads();
  } catch (err) {
    log(`snapshot: no upload URLs (${err.message})`);
    return;
  }
  if (!targets?.bundle || !targets?.tarball) return; // not a graded run
  if (!existsSync(path.join(submissionDir, ".git"))) {
    log("snapshot: the submission is not a git checkout; skipped");
    return;
  }
  const files = {
    bundle: { file: path.join(workdir, "snapshot.bundle"), type: "application/x-git-bundle" },
    tarball: { file: path.join(workdir, "snapshot.tar.gz"), type: "application/gzip" },
  };
  const made = [
    await run("git", ["-C", submissionDir, "bundle", "create", files.bundle.file, "HEAD"], { timeoutMs: 300_000 }),
    await run("git", ["-C", submissionDir, "archive", "--format=tar.gz", "-o", files.tarball.file, "HEAD"], {
      timeoutMs: 300_000,
    }),
  ];
  const failed = made.find((r) => r.code !== 0);
  if (failed) {
    log(`snapshot: git failed: ${tailLines(failed.stderr, 3)}`);
    return;
  }
  const out = {};
  for (const [kind, { file, type }] of Object.entries(files)) {
    const body = readFileSync(file);
    const res = await fetch(targets[kind].url, { method: "PUT", headers: { "content-type": type }, body }).catch(
      (err) => ({ ok: false, status: err.message }),
    );
    if (!res.ok) {
      log(`snapshot: upload of the ${kind} failed (${res.status})`);
      return;
    }
    out[`${kind}_sha256`] = createHash("sha256").update(body).digest("hex");
    out[`${kind}_size`] = body.length;
  }
  results.snapshot = out;
  log(`snapshot: archived (${out.bundle_size + out.tarball_size} bytes)`);
}

async function main() {
  await snapshot();
  try {
    let ok = await stage("contract", contract);
    for (const key of ["lint", "student_tests"]) {
      const def = profile.stages?.[key];
      const share = options.stages?.[key]?.share;
      if (!def?.image || !def?.run || typeof share !== "number") continue;
      if (ok) {
        await stage(key, async () => {
          const outcome = await toolchains.runStage(key, def, share);
          return { ...outcome, tests: outcome.tests.map((t) => cleanTest(t, "")) };
        });
      } else results.stages.push({ key, status: "skipped", duration_ms: 0, share });
    }
    for (const [key, fn] of [
      ["build", build],
      ["health", health],
    ]) {
      if (ok) ok = await stage(key, fn);
      else results.stages.push({ key, status: "skipped", duration_ms: 0 });
    }
    const blockedBy = results.stages.find((s) => GATING.includes(s.key) && s.status !== "passed")?.key;
    for (const def of manifest.stages) {
      if (options.skip_kinds?.includes(def.kind ?? "api")) {
        results.stages.push({
          key: def.key,
          status: "skipped",
          duration_ms: 0,
          message: "Turned off for this assignment.",
        });
      } else if (blockedBy) {
        const tests = (await listTests(def.file)).map((t) => ({
          ...t,
          status: "skipped",
          message: `Not run: the ${blockedBy} stage failed.`,
        }));
        results.stages.push({ key: def.key, status: "skipped", duration_ms: 0, tests });
      } else {
        await stage(def.key, () => testStage(def));
      }
    }
  } catch (err) {
    results.infra_error = err instanceof InfraError ? err.message : `Grader error: ${err?.stack ?? err}`;
    log(`infra error: ${results.infra_error}`);
  } finally {
    if (composePath && !args.keep) {
      await run("docker", compose("down", "-v", "--remove-orphans", "-t", "5"), { timeoutMs: 120_000 });
    }
    if (!args.keep) await toolchains.cleanup();
    if (!args.keep) rmSync(workdir, { recursive: true, force: true });
  }
  results.finished_at = new Date().toISOString();
  results.infra_error = results.infra_error ? clip(redact(results.infra_error, secrets), 1900) : null;
  mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  writeFileSync(args.out, JSON.stringify(results, null, 2));

  const tests = results.stages.flatMap((s) => s.tests ?? []);
  log(
    `done: ${tests.filter((t) => t.status === "passed").length}/${tests.length} tests passed` +
      (results.infra_error ? " (infra error)" : ""),
  );
  if (callbacks) await callbacks.results(results);
}

if (callbacks) {
  try {
    await callbacks.started();
  } catch (err) {
    console.error(`[hbe] the platform did not accept this run: ${err.message}`);
    process.exit(1);
  }
}
try {
  await main();
} catch (err) {
  console.error(`[hbe] could not finish: ${err.message}`);
  process.exit(1);
}
