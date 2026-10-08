/**
 * The stack profile's own stages: lint and the student's tests (docs/ARCHITECTURE.md §6.1).
 *
 * Each runs in a fresh container of the stage's `image`, on a Docker volume holding a copy of
 * the student's repository (never the suite, never a host mount), with memory, CPU and process
 * limits and a minimal environment. `setup` (installing dependencies) runs once per image and
 * setup command; it has internet access, like the build. A stage passes when its command exits
 * 0 and, for `report: junit`, the JUnit file lists no failures.
 */
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { looksLikeInfraFailure, run } from "./exec.mjs";
import { parseJUnit } from "./junit.mjs";

const LIMITS = ["--memory", "2g", "--pids-limit", "1024", "--cpus", "2"];
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
 *   remaining: (maxMs: number) => number, infra: (message: string) => never }} ctx
 */
export function createToolchains({ project, submissionDir, workdir, remaining, infra }) {
  const prepared = new Map();
  const volumes = [];
  let seq = 0;

  /** Runs `command` in a fresh container on the volume; the container is always removed. */
  async function sandbox(volume, image, command, timeoutMs) {
    const name = `${project}-tc${++seq}`;
    const r = await run(
      "docker",
      [
        "run",
        "--name",
        name,
        "-v",
        `${volume}:/work`,
        "-w",
        "/work",
        ...LIMITS,
        "-e",
        "CI=true",
        "-e",
        "HOME=/tmp",
        "--entrypoint",
        "sh",
        image,
        "-c",
        command,
      ],
      { timeoutMs, maxOutput: 256 * 1024 },
    );
    await run("docker", ["rm", "-f", name], { timeoutMs: 30_000 });
    return { ...r, output: `${r.stdout}${r.stderr}` };
  }

  async function prepareVolume(def) {
    const volume = `${project}-vol${volumes.length}`;
    volumes.push(volume);
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

  async function readJUnit(volume, image, file) {
    const holder = `${project}-junit${++seq}`;
    const local = path.join(workdir, `junit-${seq}.xml`);
    await run("docker", ["create", "--name", holder, "-v", `${volume}:/work`, image], { timeoutMs: 30_000 });
    const cp = await run("docker", ["cp", "-L", `${holder}:/work/${file}`, local], { timeoutMs: 60_000 });
    await run("docker", ["rm", "-f", holder], { timeoutMs: 30_000 });
    if (cp.code !== 0) return null;
    try {
      if (statSync(local).size > 5 * 1024 * 1024) return null;
      const report = parseJUnit(readFileSync(local, "utf8"));
      return report.total > 0 ? report : null;
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
    const junit = def.report === "junit" && def.junit ? await readJUnit(volume, def.image, def.junit) : null;
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

  async function cleanup() {
    for (const volume of volumes) await run("docker", ["volume", "rm", "-f", volume], { timeoutMs: 60_000 });
  }

  return { runStage, cleanup };
}
