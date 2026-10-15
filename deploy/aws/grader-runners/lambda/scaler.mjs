// Decides how many grader runners to start and which to stop. No AWS or GitHub calls here:
// the handler (index.mjs) passes them in, so this is tested with fakes (test/scaler.test.mjs).
//
// Each runner is one EC2 instance running one job with a just-in-time (JIT) runner config,
// then shutting down (and so terminating). Runners aren't tied to a job: any queued job with
// our labels takes whichever runner is free.

import { randomUUID } from "node:crypto";

/** Labels GitHub gives every self-hosted runner of ours (Linux x64) besides its own. */
const DEFAULT_LABELS = ["self-hosted", "linux", "x64"];

/**
 * Whether a job is for our runners: it asks for all of our own labels (e.g. hbe-grader), and
 * nothing a runner of ours doesn't have.
 */
export function wantsOurRunners(jobLabels, labels) {
  const want = jobLabels.map((l) => l.toLowerCase());
  const ours = labels.map((l) => l.toLowerCase());
  const have = new Set([...DEFAULT_LABELS, ...ours]);
  return ours.every((l) => want.includes(l)) && want.every((l) => have.has(l));
}

const minutes = (ms) => ms / 60_000;

/**
 * One pass: look at the queued jobs, the registered runners and the instances, stop what is
 * stuck or idle, and start what the queue needs, up to `maxRunners`.
 *
 * deps.github: queuedJobs(), runners(), jitConfig(name, labels) → { runnerId, config }, deleteRunner(id)
 * deps.ec2:    instances() → [{ id, runnerName, launchedAt: Date }], launch(runnerName) → id, terminate(ids)
 * deps.secrets: put(runnerName, config), remove(runnerName)
 */
export async function reconcile(deps, config, now = new Date()) {
  const { github, ec2, secrets, log = () => {} } = deps;
  const [jobs, runners, instances] = await Promise.all([github.queuedJobs(), github.runners(), ec2.instances()]);
  const queued = jobs.filter((j) => wantsOurRunners(j.labels, config.labels));
  const runnerByName = new Map(runners.map((r) => [r.name, r]));
  const instanceNames = new Set(instances.map((i) => i.runnerName));

  const stop = [];
  const alive = [];
  for (const instance of instances) {
    const age = minutes(now - instance.launchedAt);
    const runner = runnerByName.get(instance.runnerName);
    let reason = null;
    if (age > config.maxLifetimeMinutes) reason = "ran past the longest a job can take";
    else if (runner && !runner.busy && runner.status === "online" && age > config.idleMinutes) reason = "idle";
    else if (!runner && age > config.bootMinutes) reason = "never registered (boot failed)";
    if (reason) stop.push({ instance, runner, reason });
    else alive.push({ instance, runner });
  }

  if (stop.length > 0) {
    await ec2.terminate(stop.map((s) => s.instance.id));
    for (const s of stop) {
      log("terminated", { instance: s.instance.id, runner: s.instance.runnerName, reason: s.reason });
      if (s.runner) await github.deleteRunner(s.runner.id).catch(() => {});
      await secrets.remove(s.instance.runnerName).catch(() => {});
    }
  }
  // Registered runners whose instance is gone (GitHub removes used JIT runners itself; these
  // are leftovers, e.g. from an instance that was terminated before its job).
  for (const r of runners) {
    if (r.name.startsWith(config.namePrefix) && !instanceNames.has(r.name) && r.status === "offline") {
      await github.deleteRunner(r.id).catch(() => {});
    }
  }

  // Free capacity: instances still booting, and registered runners without a job yet.
  const waiting = alive.filter(({ runner }) => !runner || !runner.busy).length;
  const room = Math.max(0, config.maxRunners - alive.length);
  const start = Math.min(Math.max(0, queued.length - waiting), room);
  const started = [];
  for (let n = 0; n < start; n++) {
    const name = `${config.namePrefix}${randomUUID().slice(0, 13)}`;
    const jit = await github.jitConfig(name, config.labels);
    try {
      await secrets.put(name, jit.config);
      started.push(await ec2.launch(name));
    } catch (err) {
      await github.deleteRunner(jit.runnerId).catch(() => {});
      await secrets.remove(name).catch(() => {});
      log("launch failed", { runner: name, error: String(err?.message ?? err) });
      break; // likely the same for the rest (capacity, limits); the next pass tries again
    }
  }
  if (started.length > 0) log("started", { instances: started });
  return {
    queued: queued.length,
    waiting,
    started: started.length,
    stopped: stop.length,
    atCapacity: queued.length - waiting > room,
  };
}

/** Capacity errors worth trying another instance type (or on-demand) for. */
export const CAPACITY_ERRORS = new Set([
  "InsufficientInstanceCapacity",
  "SpotMaxPriceTooLow",
  "MaxSpotInstanceCountExceeded",
  "UnfulfillableCapacity",
  "InsufficientCapacity",
]);

/**
 * Starts an instance: each instance type as spot, then (if allowed) each as on-demand.
 * run(params) → instance id; throws the EC2 error (with .name) on failure.
 */
export async function launchWithFallback(run, { instanceTypes, subnets, onDemandFallback }, runnerName) {
  const attempts = [
    ...instanceTypes.map((type) => ({ type, spot: true })),
    ...(onDemandFallback ? instanceTypes.map((type) => ({ type, spot: false })) : []),
  ];
  let last;
  for (const [i, { type, spot }] of attempts.entries()) {
    try {
      return await run({ instanceType: type, spot, subnet: subnets[i % subnets.length], runnerName });
    } catch (err) {
      last = err;
      if (!CAPACITY_ERRORS.has(err?.name ?? err?.Code)) throw err;
    }
  }
  throw last ?? new Error("no instance types configured");
}
