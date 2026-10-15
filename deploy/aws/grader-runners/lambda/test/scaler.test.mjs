// node --test deploy/aws/grader-runners/lambda/test/
import assert from "node:assert/strict";
import { createHmac, createVerify, generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import { appJwt, githubClient, verifySignature } from "../github.mjs";
import { launchWithFallback, reconcile, wantsOurRunners } from "../scaler.mjs";

const config = {
  labels: ["hbe-grader"],
  namePrefix: "prod-",
  maxRunners: 3,
  maxLifetimeMinutes: 90,
  idleMinutes: 15,
  bootMinutes: 10,
};
const now = new Date("2026-10-15T10:00:00Z");
const ago = (m) => new Date(now.getTime() - m * 60_000);

/** GitHub, EC2 and SSM in memory. */
function fakes({ jobs = [], runners = [], instances = [], launchFails = false } = {}) {
  const calls = { launched: [], terminated: [], deleted: [], secrets: new Map(), removed: [] };
  let nextRunner = 100;
  const deps = {
    github: {
      queuedJobs: async () => jobs,
      runners: async () => runners,
      jitConfig: async (name, labels) => {
        assert.deepEqual(labels, config.labels);
        return { runnerId: nextRunner++, config: `jit-for-${name}` };
      },
      deleteRunner: async (id) => void calls.deleted.push(id),
    },
    ec2: {
      instances: async () => instances,
      launch: async (name) => {
        if (launchFails) throw Object.assign(new Error("no capacity"), { name: "InsufficientInstanceCapacity" });
        calls.launched.push(name);
        return `i-${calls.launched.length}`;
      },
      terminate: async (ids) => void calls.terminated.push(...ids),
    },
    secrets: {
      put: async (name, value) => void calls.secrets.set(name, value),
      remove: async (name) => void calls.removed.push(name),
    },
  };
  return { deps, calls };
}
const job = (labels = ["self-hosted", "hbe-grader"]) => ({ id: Math.random(), labels });

describe("which jobs are ours", () => {
  it("needs our label, and nothing our runners lack", () => {
    assert.equal(wantsOurRunners(["self-hosted", "hbe-grader"], ["hbe-grader"]), true);
    assert.equal(wantsOurRunners(["self-hosted", "Linux", "X64", "hbe-grader"], ["hbe-grader"]), true);
    assert.equal(wantsOurRunners(["ubuntu-latest"], ["hbe-grader"]), false);
    assert.equal(wantsOurRunners(["self-hosted"], ["hbe-grader"]), false);
    assert.equal(wantsOurRunners(["self-hosted", "hbe-grader", "gpu"], ["hbe-grader"]), false);
  });
});

describe("reconcile", () => {
  it("starts a runner per queued job, with its JIT config stored for the instance", async () => {
    const { deps, calls } = fakes({ jobs: [job(), job(), job(["ubuntu-latest"])] });
    const result = await reconcile(deps, config, now);
    assert.equal(result.started, 2);
    assert.equal(calls.launched.length, 2);
    for (const name of calls.launched) {
      assert.match(name, /^prod-/);
      assert.equal(calls.secrets.get(name), `jit-for-${name}`);
    }
  });

  it("counts runners still booting or idle, so a job doesn't get two", async () => {
    const { deps, calls } = fakes({
      jobs: [job(), job()],
      runners: [{ id: 1, name: "prod-a", status: "online", busy: false }],
      instances: [
        { id: "i-a", runnerName: "prod-a", launchedAt: ago(3) },
        { id: "i-b", runnerName: "prod-b", launchedAt: ago(1) }, // booting
      ],
    });
    const result = await reconcile(deps, config, now);
    assert.equal(result.started, 0);
    assert.deepEqual(calls.launched, []);
  });

  it("never runs more than maxRunners, and says when the queue waits", async () => {
    const { deps, calls } = fakes({
      jobs: [job(), job(), job(), job()],
      runners: [{ id: 1, name: "prod-a", status: "online", busy: true }],
      instances: [{ id: "i-a", runnerName: "prod-a", launchedAt: ago(20) }],
    });
    const result = await reconcile(deps, config, now);
    assert.equal(calls.launched.length, 2);
    assert.equal(result.atCapacity, true);
  });

  it("stops runners that idle, never register, or run too long, and removes what they left", async () => {
    const { deps, calls } = fakes({
      runners: [
        { id: 1, name: "prod-idle", status: "online", busy: false },
        { id: 2, name: "prod-busy", status: "online", busy: true },
        { id: 3, name: "prod-long", status: "online", busy: true },
        { id: 4, name: "prod-gone", status: "offline", busy: false },
        { id: 5, name: "someone-else", status: "offline", busy: false },
      ],
      instances: [
        { id: "i-idle", runnerName: "prod-idle", launchedAt: ago(16) },
        { id: "i-busy", runnerName: "prod-busy", launchedAt: ago(60) },
        { id: "i-long", runnerName: "prod-long", launchedAt: ago(91) },
        { id: "i-stuck", runnerName: "prod-stuck", launchedAt: ago(11) },
        { id: "i-new", runnerName: "prod-new", launchedAt: ago(2) },
      ],
    });
    const result = await reconcile(deps, config, now);
    assert.deepEqual(calls.terminated.sort(), ["i-idle", "i-long", "i-stuck"]);
    assert.deepEqual(calls.deleted.sort(), [1, 3, 4]);
    assert.deepEqual(calls.removed.sort(), ["prod-idle", "prod-long", "prod-stuck"]);
    assert.equal(result.stopped, 3);
  });

  it("cleans up when an instance can't start, and tries again next pass", async () => {
    const { deps, calls } = fakes({ jobs: [job(), job()], launchFails: true });
    const result = await reconcile(deps, config, now);
    assert.equal(result.started, 0);
    assert.deepEqual(calls.deleted, [100]); // only the first: it stops at the first failure
    assert.equal(calls.removed.length, 1);
  });
});

describe("launching", () => {
  const options = {
    instanceTypes: ["c6i.large", "m6i.large"],
    subnets: ["subnet-a", "subnet-b"],
    onDemandFallback: true,
  };
  const capacity = () => Object.assign(new Error("none"), { name: "InsufficientInstanceCapacity" });

  it("tries each type as spot, then on-demand", async () => {
    const tried = [];
    const id = await launchWithFallback(
      async (p) => {
        tried.push(`${p.instanceType}/${p.spot ? "spot" : "on-demand"}/${p.subnet}`);
        if (tried.length < 3) throw capacity();
        return "i-1";
      },
      options,
      "prod-x",
    );
    assert.equal(id, "i-1");
    assert.deepEqual(tried, ["c6i.large/spot/subnet-a", "m6i.large/spot/subnet-b", "c6i.large/on-demand/subnet-a"]);
  });

  it("doesn't retry other errors, or use on-demand unless allowed", async () => {
    await assert.rejects(
      launchWithFallback(
        async () => {
          throw Object.assign(new Error("denied"), { name: "UnauthorizedOperation" });
        },
        options,
        "x",
      ),
      /denied/,
    );
    let n = 0;
    await assert.rejects(
      launchWithFallback(
        async () => {
          n++;
          throw capacity();
        },
        { ...options, onDemandFallback: false },
        "x",
      ),
      /none/,
    );
    assert.equal(n, 2);
  });
});

describe("GitHub", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });

  it("signs App JWTs with the App's key", () => {
    const jwt = appJwt(12345, pem, Date.parse("2026-10-15T10:00:00Z"));
    const [h, p, sig] = jwt.split(".");
    assert.equal(JSON.parse(Buffer.from(p, "base64url")).iss, "12345");
    assert.equal(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(sig, "base64url")), true);
  });

  it("accepts only webhooks signed with the secret", () => {
    const body = '{"action":"queued"}';
    const good = `sha256=${createHmac("sha256", "s3cret").update(body).digest("hex")}`;
    assert.equal(verifySignature("s3cret", body, good), true);
    assert.equal(verifySignature("other", body, good), false);
    assert.equal(verifySignature("s3cret", `${body} `, good), false);
    assert.equal(verifySignature("s3cret", body, undefined), false);
  });

  it("lists queued jobs and registers JIT runners with an installation token", async () => {
    const seen = [];
    const fake = async (url, init) => {
      const path = url.replace("https://api.github.com", "");
      seen.push(
        `${init.method} ${path} ${init.headers.authorization.startsWith("Bearer ey") ? "jwt" : init.headers.authorization}`,
      );
      const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
      if (path === "/repos/o/grader/installation") return json({ id: 7 });
      if (path === "/app/installations/7/access_tokens") {
        return json({ token: "ghs_x", expires_at: new Date(Date.now() + 3600_000).toISOString() }, 201);
      }
      if (path.startsWith("/repos/o/grader/actions/runs?")) return json({ workflow_runs: [{ id: 1 }] });
      if (path.startsWith("/repos/o/grader/actions/runs/1/jobs")) {
        return json({
          jobs: [
            { id: 9, status: "queued", labels: ["self-hosted", "hbe-grader"] },
            { id: 10, status: "completed" },
          ],
        });
      }
      if (path === "/repos/o/grader/actions/runners/generate-jitconfig") {
        assert.deepEqual(JSON.parse(init.body), {
          name: "prod-1",
          runner_group_id: 1,
          labels: ["hbe-grader"],
          work_folder: "_work",
        });
        return json({ runner: { id: 55 }, encoded_jit_config: "abc" }, 201);
      }
      throw new Error(`unexpected ${path}`);
    };
    const gh = githubClient({ appId: 1, privateKey: pem, repository: "o/grader", fetchImpl: fake });
    assert.deepEqual(await gh.queuedJobs(), [{ id: 9, labels: ["self-hosted", "hbe-grader"] }]);
    assert.deepEqual(await gh.jitConfig("prod-1", ["hbe-grader"]), { runnerId: 55, config: "abc" });
    assert.deepEqual(seen, [
      "GET /repos/o/grader/installation jwt",
      "POST /app/installations/7/access_tokens jwt",
      "GET /repos/o/grader/actions/runs?status=queued&per_page=100 Bearer ghs_x",
      "GET /repos/o/grader/actions/runs/1/jobs?filter=latest&per_page=100 Bearer ghs_x",
      "POST /repos/o/grader/actions/runners/generate-jitconfig Bearer ghs_x",
    ]);
  });
});
