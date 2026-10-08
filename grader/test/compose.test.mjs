import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { prepareCompose, redact, SERVICE_LIMITS } from "../harness/lib/compose.mjs";

const submissionDir = "/work/submission";
const options = { submissionDir, project: "hbe-test", realpath: (p) => path.resolve(p) };
const profile = { services: { backend: { port: 4000, health: "/health" } }, datastores: [], env_required: [] };

const resolved = (backend = {}, extra = {}) => ({
  name: "submission",
  services: {
    backend: {
      build: { context: submissionDir, dockerfile: "Dockerfile" },
      command: null,
      environment: { PORT: "4000" },
      networks: { default: null },
      ports: [{ mode: "ingress", target: 4000, published: "4000", protocol: "tcp" }],
      ...backend,
    },
  },
  networks: { default: { name: "submission_default" } },
  ...extra,
});

describe("prepareCompose", () => {
  it("isolates a valid project on an internal network with limits", () => {
    const { config, problems } = prepareCompose(resolved({ container_name: "fixed" }), profile, options);
    assert.deepEqual(problems, []);
    assert.deepEqual(config.networks, { hbe: { name: "hbe-test-net", internal: true } });
    const backend = config.services.backend;
    assert.equal(backend.ports, undefined);
    assert.equal(backend.container_name, undefined);
    assert.equal("command" in backend, false);
    assert.deepEqual(backend.networks, { hbe: {} });
    assert.equal(backend.restart, "no");
    assert.equal(backend.mem_limit, SERVICE_LIMITS.mem_limit);
    assert.equal(backend.pids_limit, SERVICE_LIMITS.pids_limit);
    assert.deepEqual(backend.environment, { PORT: "4000" });
  });

  it("requires the services the stack profile declares", () => {
    const { problems } = prepareCompose(
      resolved(),
      { ...profile, services: { ...profile.services, frontend: { port: 3000 } } },
      options,
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /service named "frontend".*port 3000/);
  });

  it("rejects settings that reach outside the container", () => {
    const { config, problems } = prepareCompose(
      resolved({
        privileged: true,
        network_mode: "host",
        cap_add: ["SYS_ADMIN"],
        pid: "host",
        use_api_socket: true,
        volumes: [
          { type: "bind", source: "/var/run/docker.sock", target: "/var/run/docker.sock" },
          { type: "bind", source: "/etc", target: "/host-etc" },
          { type: "bind", source: `${submissionDir}/src`, target: "/app/src" },
          { type: "volume", source: "data", target: "/data" },
          { type: "tmpfs", target: "/tmp" },
        ],
      }),
      profile,
      options,
    );
    assert.equal(config, null);
    assert.equal(problems.length, 7);
    assert.ok(problems.some((p) => p.includes("privileged")));
    assert.ok(problems.some((p) => p.includes("network_mode")));
    assert.ok(problems.some((p) => p.includes("cap_add")));
    assert.ok(problems.some((p) => p.includes("`pid`")));
    assert.ok(problems.some((p) => p.includes("Docker API socket")));
    assert.ok(problems.some((p) => p.includes("/var/run/docker.sock")));
    assert.ok(problems.some((p) => p.includes("/etc")));
  });

  it("follows symlinks when checking mounts", () => {
    const realpath = (p) => (p === `${submissionDir}/link` ? "/" : path.resolve(p));
    const { problems } = prepareCompose(
      resolved({ volumes: [{ type: "bind", source: `${submissionDir}/link`, target: "/host" }] }),
      profile,
      { ...options, realpath },
    );
    assert.equal(problems.length, 1);
  });

  it("only builds from inside the repository, without secrets or host networking", () => {
    const outside = prepareCompose(resolved({ build: { context: "/work/grader/suites" } }), profile, options);
    assert.match(outside.problems[0], /builds from outside your repository/);
    const remote = prepareCompose(resolved({ build: { context: "https://github.com/x/y.git" } }), profile, options);
    assert.match(remote.problems[0], /remote context/);
    const sneaky = prepareCompose(
      resolved({
        build: {
          context: submissionDir,
          secrets: [{ source: "token" }],
          network: "host",
          additional_contexts: { suite: "/work/grader", base: "docker-image://node:22" },
        },
      }),
      profile,
      options,
    );
    assert.equal(sneaky.problems.length, 3);
  });

  it("rejects volumes, secrets and configs that point at the host", () => {
    const { problems } = prepareCompose(
      resolved(
        {},
        {
          volumes: { data: { driver_opts: { type: "none", o: "bind", device: "/" } }, ok: { name: "ok" } },
          secrets: { key: { file: "/root/.ssh/id_rsa" }, local: { file: `${submissionDir}/secret.txt` } },
          configs: { env: { environment: "ACTIONS_ID_TOKEN_REQUEST_TOKEN" } },
        },
      ),
      profile,
      options,
    );
    assert.equal(problems.length, 3);
  });

  it("adds datastores and the environment the profile promises", () => {
    const { config, env, secrets } = prepareCompose(
      resolved({ environment: { MONGODB_URI: "mongodb://localhost/dev", PORT: "4000" } }),
      { ...profile, datastores: ["mongo:7", "postgres:16"], env_required: ["MONGODB_URI", "JWT_SECRET"] },
      options,
    );
    assert.equal(config.services["hbe-mongo"].image, "mongo:7");
    assert.deepEqual(config.services["hbe-mongo"].networks, { hbe: {} });
    assert.equal(config.services["hbe-postgres"].image, "postgres:16");
    assert.equal(env.MONGODB_URI, "mongodb://hbe-mongo:27017/app");
    assert.match(env.DATABASE_URL, /^postgres:\/\/app:[0-9a-f]{24}@hbe-postgres:5432\/app$/);
    assert.match(env.JWT_SECRET, /^[0-9a-f]{48}$/);
    // The harness's values win over the student's development defaults.
    assert.equal(config.services.backend.environment.MONGODB_URI, "mongodb://hbe-mongo:27017/app");
    assert.equal(config.services.backend.environment.PORT, "4000");
    assert.equal(secrets.length, 2); // postgres password and JWT_SECRET
    assert.throws(
      () => prepareCompose(resolved(), { ...profile, datastores: ["oracle:23"] }, options),
      /not supported/,
    );
  });
});

describe("redact", () => {
  it("hides secrets in text shown to students", () => {
    assert.equal(redact("token=abcdef123 and abcdef123", ["abcdef123"]), "token=[redacted] and [redacted]");
    assert.equal(redact("short", ["abc"]), "short");
  });
});
