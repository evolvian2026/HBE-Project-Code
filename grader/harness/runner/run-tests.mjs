/**
 * Runs inside the tester container, on the app's internal network (never inside the student's
 * containers, so they can't read the suite). Prints one JSON document to stdout.
 *
 *   node run-tests.mjs health   HBE_RUNNER_CONFIG={"targets":[{"service","url"}],"timeoutMs"}
 *   node run-tests.mjs tests    HBE_RUNNER_CONFIG={"suiteFile","services":{name:url},"testTimeoutMs",
 *                               "browser"?:{"service"}}
 *
 * Browser stages run in the Playwright image (HBE_PLAYWRIGHT points at playwright-core): each
 * test gets a fresh page on the browser service; a failed test leaves a screenshot and a trace
 * (without test sources) in /out, named in the test's `attachments`.
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

/** Errors from Playwright (an element that never appeared, a page that didn't load) are the app's. */
const isPlaywrightError = (err) =>
  err?.name === "TimeoutError" || /^(locator|page|frame|elementHandle|browserContext)\.\w+:/.test(err?.message ?? "");
const firstLine = (s) => String(s).split("\n")[0];
const safeName = (id) => id.replace(/[^\w.-]/g, "_");

async function tests() {
  const suite = (await import(pathToFileURL(config.suiteFile).href)).default;
  const browserBase = config.browser ? config.services[config.browser.service] : null;
  const browser = config.browser
    ? await (await import(pathToFileURL(process.env.HBE_PLAYWRIGHT).href)).chromium.launch()
    : null;
  const out = [];
  for (const test of suite.tests) {
    const { t, exchanges, progress } = createContext({ services: config.services });
    let context = null;
    const consoleLines = [];
    if (browser) {
      context = await browser.newContext({ baseURL: browserBase, viewport: { width: 1280, height: 800 } });
      await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      page.on("console", (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));
      page.on("pageerror", (e) => consoleLines.push(`[page error] ${e.message}`));
      t.page = page;
    }
    const base = {
      id: test.id,
      title: test.title,
      category: test.category,
      weight: test.weight ?? 1,
      hint: test.hint,
      staff_notes: test.staff_notes,
    };
    const started = Date.now();
    const timeoutMs = test.timeoutMs ?? config.testTimeoutMs ?? (browser ? 45_000 : 20_000);
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
      if (context) await context.tracing.stop().catch(() => {});
    } catch (err) {
      const last = exchanges.at(-1);
      const playwright = Boolean(browser) && isPlaywrightError(err);
      const failure = err instanceof AssertionFailure || playwright;
      const step = progress.step;
      const message = playwright ? firstLine(err.message) : (err?.message ?? String(err));
      const evidence = {
        ...(last ? { request: last.request, response: last.response } : {}),
        ...(step ? { step } : {}),
        ...(playwright ? { playwright: err.message } : {}),
        ...(consoleLines.length ? { console: consoleLines.slice(-40).join("\n") } : {}),
      };
      const attachments = context ? await capture(context, t.page, safeName(test.id)) : {};
      out.push({
        ...base,
        // "error" means the suite itself broke, not the student's app.
        status: failure ? "failed" : "error",
        duration_ms: Date.now() - started,
        message: failure ? `${step ? `${step}: ` : ""}${message}` : `The test could not run: ${message}`,
        ...(failure && err.expected !== undefined ? { expected: String(err.expected) } : {}),
        ...(failure && err.actual !== undefined ? { actual: String(err.actual) } : {}),
        ...(Object.keys(evidence).length ? { evidence } : {}),
        ...(Object.keys(attachments).length ? { attachments } : {}),
      });
    } finally {
      clearTimeout(timer);
      if (context) await context.close().catch(() => {});
    }
  }
  if (browser) await browser.close();
  return out;
}

/** A failed browser test's screenshot and trace, written to /out. */
async function capture(context, page, name) {
  const attachments = {};
  try {
    await page.screenshot({ path: `/out/${name}.png`, timeout: 5000 });
    attachments.screenshot = `${name}.png`;
  } catch {
    // The page may have crashed; the trace still helps.
  }
  try {
    await context.tracing.stop({ path: `/out/${name}.trace.zip` });
    attachments.trace = `${name}.trace.zip`;
  } catch {
    // Nothing recorded.
  }
  return attachments;
}

const result = mode === "health" ? await health() : mode === "tests" ? await tests() : null;
if (result === null) {
  console.error(`unknown mode ${mode}`);
  process.exit(2);
}
process.stdout.write(JSON.stringify(result));
