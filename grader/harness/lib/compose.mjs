import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";

/**
 * Turns the student's Compose project (as resolved by `docker compose config --format json`)
 * into the one the grader runs:
 *
 * - settings that reach outside the container (host networking, privileged mode, host
 *   paths, the Docker socket, build secrets) are rejected with a message the student can act on;
 * - every service joins one internal network with no internet access, and published ports
 *   are dropped: the hidden tests reach the app from their own container on that network;
 * - the stack profile's datastores are added, and its required environment variables are
 *   set (datastore URLs, plus random secrets such as JWT_SECRET);
 * - memory and process limits are applied.
 *
 * Pure apart from random secrets and resolving symlinks, so it is unit-tested directly.
 */

const FORBIDDEN_SERVICE_KEYS = {
  privileged: "privileged mode",
  network_mode: "a custom network mode",
  pid: "sharing the host's process namespace",
  ipc: "sharing the host's IPC namespace",
  uts: "sharing the host's UTS namespace",
  userns_mode: "a custom user namespace",
  cap_add: "extra Linux capabilities",
  devices: "host devices",
  device_cgroup_rules: "device cgroup rules",
  security_opt: "security options",
  cgroup: "a custom cgroup namespace",
  cgroup_parent: "a custom cgroup parent",
  volumes_from: "volumes from other containers",
  runtime: "a custom container runtime",
  sysctls: "kernel parameters (sysctls)",
  oom_kill_disable: "disabling the OOM killer",
  gpus: "GPUs",
  use_api_socket: "the Docker API socket",
  provider: "a service provider",
  models: "AI models",
};

const FORBIDDEN_BUILD_KEYS = {
  secrets: "build secrets",
  ssh: "SSH agent forwarding",
  entitlements: "build entitlements",
  privileged: "privileged builds",
  cache_from: "external build caches",
  cache_to: "external build caches",
};

const DATASTORES = {
  mongo: (version) => ({
    service: "hbe-mongo",
    definition: { image: `mongo:${version}` },
    env: { MONGODB_URI: "mongodb://hbe-mongo:27017/app" },
  }),
  postgres: (version) => {
    const password = randomBytes(12).toString("hex");
    return {
      service: "hbe-postgres",
      definition: {
        image: `postgres:${version}`,
        environment: { POSTGRES_USER: "app", POSTGRES_PASSWORD: password, POSTGRES_DB: "app" },
      },
      env: { DATABASE_URL: `postgres://app:${password}@hbe-postgres:5432/app` },
      secrets: [password],
    };
  },
};

export const SERVICE_LIMITS = { mem_limit: "1536m", pids_limit: 512 };

function safeRealpath(p) {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p); // does not exist (yet): Compose would create it at this path
  }
}

/**
 * @param {object} resolved Output of `docker compose config --format json`.
 * @param {object} profile The stack profile definition (services, datastores, env_required).
 * @param {{ submissionDir: string, project: string, realpath?: (p: string) => string }} options
 * @returns {{ config: object | null, problems: string[], env: Record<string, string>, secrets: string[] }}
 */
export function prepareCompose(resolved, profile, { submissionDir, project, realpath = safeRealpath }) {
  const problems = [];
  const root = realpath(submissionDir);
  const inside = (p) => {
    const real = realpath(path.resolve(submissionDir, p));
    return real === root || real.startsWith(root + path.sep);
  };
  const services = resolved?.services ?? {};

  for (const [name, spec] of Object.entries(profile.services ?? {})) {
    if (!services[name]) {
      problems.push(
        `Your compose file must define a service named "${name}" (the stack profile expects it on port ${spec.port}).`,
      );
    }
  }

  for (const [name, svc] of Object.entries(services)) {
    for (const [key, what] of Object.entries(FORBIDDEN_SERVICE_KEYS)) {
      if (svc[key] !== undefined && svc[key] !== null && svc[key] !== false) {
        problems.push(`Service "${name}" uses ${what} (\`${key}\`), which the grader does not allow.`);
      }
    }
    if (svc.build) {
      const build = svc.build;
      for (const [key, what] of Object.entries(FORBIDDEN_BUILD_KEYS)) {
        if (build[key] !== undefined && build[key] !== null) {
          problems.push(`Service "${name}" uses ${what} (\`build.${key}\`), which the grader does not allow.`);
        }
      }
      if (build.network && build.network !== "default") {
        problems.push(`Service "${name}" builds with network "${build.network}"; remove \`build.network\`.`);
      }
      const context = String(build.context ?? ".");
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(context) || context.startsWith("git@")) {
        problems.push(`Service "${name}" builds from a remote context; build from a folder in your repository.`);
      } else if (!inside(context)) {
        problems.push(`Service "${name}" builds from outside your repository (${build.context}).`);
      } else if (build.dockerfile && path.isAbsolute(build.dockerfile) && !inside(build.dockerfile)) {
        problems.push(`Service "${name}" uses a Dockerfile outside your repository.`);
      }
      for (const [ctxName, ctx] of Object.entries(build.additional_contexts ?? {})) {
        const value = String(ctx);
        if (/^(docker-image|service|oci-layout):/.test(value) || /^https?:\/\//.test(value)) continue;
        if (!inside(value))
          problems.push(`Service "${name}" has a build context "${ctxName}" outside your repository.`);
      }
    }
    for (const v of svc.volumes ?? []) {
      const type = v.type ?? "volume";
      if (type === "bind") {
        const source = String(v.source ?? "");
        if (source.includes("docker.sock") || !inside(source)) {
          problems.push(
            `Service "${name}" mounts ${source || "a host path"}; only folders inside your repository can be mounted.`,
          );
        }
      } else if (type !== "volume" && type !== "tmpfs") {
        problems.push(`Service "${name}" uses a "${type}" mount, which the grader does not allow.`);
      }
    }
    for (const file of svc.env_file ?? []) {
      const p = typeof file === "string" ? file : file?.path;
      if (p && !inside(p)) problems.push(`Service "${name}" reads an env file outside your repository.`);
    }
  }

  for (const [name, vol] of Object.entries(resolved?.volumes ?? {})) {
    if (
      vol?.external ||
      (vol?.driver && vol.driver !== "local") ||
      (vol?.driver_opts && Object.keys(vol.driver_opts).length)
    ) {
      problems.push(`Volume "${name}" must be a plain named volume (no external volumes, drivers or driver options).`);
    }
  }
  for (const kind of ["secrets", "configs"]) {
    for (const [name, item] of Object.entries(resolved?.[kind] ?? {})) {
      if (item?.external || item?.environment || (item?.file && !inside(item.file))) {
        problems.push(`The ${kind.slice(0, -1)} "${name}" must be a file inside your repository.`);
      }
    }
  }
  if (resolved?.models && Object.keys(resolved.models).length) problems.push("Compose `models` are not supported.");

  if (problems.length) return { config: null, problems, env: {}, secrets: [] };

  // Datastores and environment the profile promises the app.
  const env = {};
  const secrets = [];
  const extraServices = {};
  for (const ds of profile.datastores ?? []) {
    const [kind, version = "latest"] = String(ds).split(":");
    const make = DATASTORES[kind];
    if (!make) throw new Error(`Stack profile datastore "${ds}" is not supported by this grader`);
    const store = make(version);
    extraServices[store.service] = {
      ...store.definition,
      networks: { hbe: {} },
      restart: "no",
      ...SERVICE_LIMITS,
    };
    Object.assign(env, store.env);
    secrets.push(...(store.secrets ?? []));
  }
  for (const key of profile.env_required ?? []) {
    if (env[key] === undefined) {
      env[key] = randomBytes(24).toString("hex");
      secrets.push(env[key]);
    }
  }

  const out = {
    name: project,
    services: {},
    networks: { hbe: { name: `${project}-net`, internal: true } },
  };
  for (const kind of ["volumes", "secrets", "configs"]) if (resolved[kind]) out[kind] = resolved[kind];
  for (const [name, svc] of Object.entries(services)) {
    const copy = Object.fromEntries(Object.entries(svc).filter(([, v]) => v !== null));
    delete copy.ports;
    delete copy.networks;
    delete copy.container_name;
    delete copy.env_file; // already merged into environment by `docker compose config`
    copy.networks = { hbe: {} };
    copy.restart = "no";
    copy.environment = { ...(svc.environment ?? {}), ...env };
    Object.assign(copy, SERVICE_LIMITS);
    out.services[name] = copy;
  }
  Object.assign(out.services, extraServices);
  return { config: out, problems: [], env, secrets };
}

/** Replaces secret values in text shown to students. */
export function redact(text, secrets) {
  let out = String(text ?? "");
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join("[redacted]");
  return out;
}
