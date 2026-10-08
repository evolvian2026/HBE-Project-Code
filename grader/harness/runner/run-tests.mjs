/**
 * Runs inside the tester container, on the app's internal network (never inside the student's
 * containers, so they can't read the suite). Prints one JSON document to stdout.
 *
 *   node run-tests.mjs health   HBE_RUNNER_CONFIG={"targets":[{"service","url"}],"timeoutMs"}
 *   node run-tests.mjs tests    HBE_RUNNER_CONFIG={"suiteFile","services":{name:url},"testTimeoutMs"}
 */
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { AssertionFailure, createContext } from "./context.mjs";

const mode = process.argv[2];
const config = JSON.parse(process.env.HBE_RUNNER_CONFIG ?? "{}");

async function health() {
  const deadline = Date.now() + (config.timeoutMs ?? 120_000);
  const results = [];
  for (const target of config.targets) {
    let last = "not checked";
    let ok = false;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(target.url, { signal: AbortSignal.timeout(5000), redirect: "manual" });
        last = `HTTP ${res.status}`;
        if (res.status < 400) {
          ok = true;
          break;
        }
      } catch (err) {
        last = err?.cause?.code ?? err?.name ?? String(err);
      }
      await sleep(1000);
    }
    results.push({ service: target.service, url: target.url, ok, last });
  }
  return { ok: results.every((r) => r.ok), results };
}

async function tests() {
  const suite = (await import(pathToFileURL(config.suiteFile).href)).default;
  const out = [];
  for (const test of suite.tests) {
    const { t, exchanges } = createContext({ services: config.services });
    const base = {
      id: test.id,
      title: test.title,
      category: test.category,
      weight: test.weight ?? 1,
      hint: test.hint,
      staff_notes: test.staff_notes,
    };
    const started = Date.now();
    const timeoutMs = test.timeoutMs ?? config.testTimeoutMs ?? 20_000;
    let timer;
    try {
      await Promise.race([
        test.run(t),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new AssertionFailure(`The test did not finish within ${timeoutMs / 1000} s`)),
            timeoutMs,
          );
        }),
      ]);
      out.push({ ...base, status: "passed", duration_ms: Date.now() - started });
    } catch (err) {
      const last = exchanges.at(-1);
      const failure = err instanceof AssertionFailure;
      out.push({
        ...base,
        // "error" means the suite itself broke, not the student's app.
        status: failure ? "failed" : "error",
        duration_ms: Date.now() - started,
        message: failure ? err.message : `The test could not run: ${err?.message ?? err}`,
        ...(failure && err.expected !== undefined ? { expected: String(err.expected) } : {}),
        ...(failure && err.actual !== undefined ? { actual: String(err.actual) } : {}),
        ...(last ? { evidence: { request: last.request, response: last.response } } : {}),
      });
    } finally {
      clearTimeout(timer);
    }
  }
  return out;
}

const result = mode === "health" ? await health() : mode === "tests" ? await tests() : null;
if (result === null) {
  console.error(`unknown mode ${mode}`);
  process.exit(2);
}
process.stdout.write(JSON.stringify(result));
