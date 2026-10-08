import { spawn } from "node:child_process";

/**
 * The environment for every child process. Student-controlled files (compose.yaml, .env)
 * can interpolate environment variables into builds and containers, so children get only
 * what Docker needs: never the runner's OIDC request token or any other secret.
 */
export function cleanEnv(extra = {}) {
  const keep = ["PATH", "HOME", "LANG", "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY"];
  const env = {};
  for (const key of keep) if (process.env[key] !== undefined) env[key] = process.env[key];
  return { ...env, DOCKER_BUILDKIT: "1", COMPOSE_ANSI: "never", BUILDKIT_PROGRESS: "plain", ...extra };
}

/**
 * Runs a command with a time limit, keeping the tail of its output (student builds can log
 * a lot). Never throws for a non-zero exit: callers decide what a failure means.
 */
export function run(command, args, { cwd, timeoutMs = 60_000, maxOutput = 64 * 1024, input } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, args, { cwd, env: cleanEnv(), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const keepTail = (buf, chunk) => {
      const next = buf + chunk;
      return next.length > maxOutput ? next.slice(next.length - maxOutput) : next;
    };
    child.stdout.on("data", (c) => (stdout = keepTail(stdout, c.toString())));
    child.stderr.on("data", (c) => (stderr = keepTail(stderr, c.toString())));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}${err.message}`, timedOut, durationMs: Date.now() - started });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut, durationMs: Date.now() - started });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/** Output that points at the platform rather than the student's code. */
const INFRA_SIGNATURES = [
  /toomanyrequests/i,
  /429 Too Many Requests/i,
  /no space left on device/i,
  /Cannot connect to the Docker daemon/i,
  /error during connect/i,
];

export const looksLikeInfraFailure = (output) => INFRA_SIGNATURES.some((re) => re.test(output));
