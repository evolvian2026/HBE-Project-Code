// GitHub, as the runners' GitHub App (installed on the grader repository only, with
// Administration: write to register runners, and the workflow_job webhook).
import { createHmac, createSign, timingSafeEqual } from "node:crypto";

const API = "https://api.github.com";
const b64url = (data) => Buffer.from(data).toString("base64url");

/** A GitHub App JWT (RS256, valid 9 minutes, issued a minute early for clock drift). */
export function appJwt(appId, privateKeyPem, now = Date.now()) {
  const iat = Math.floor(now / 1000) - 60;
  const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(
    JSON.stringify({ iat, exp: iat + 600, iss: String(appId) }),
  )}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKeyPem).toString("base64url");
  return `${unsigned}.${signature}`;
}

/** Whether a webhook body was signed with the secret (X-Hub-Signature-256). */
export function verifySignature(secret, body, header) {
  if (!header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** The grader repository's runner API, with an installation token refreshed as needed. */
export function githubClient({ appId, privateKey, repository, fetchImpl = fetch }) {
  let token = null;
  const call = async (method, path, { body, auth } = {}) => {
    const res = await fetchImpl(`${API}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "hbe-grader-runners",
        authorization: `Bearer ${auth ?? (await installationToken())}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`GitHub ${method} ${path}: HTTP ${res.status} ${json?.message ?? ""}`.trim());
    return json;
  };
  async function installationToken() {
    if (token && token.expiresAt - Date.now() > 5 * 60_000) return token.value;
    const jwt = appJwt(appId, privateKey);
    const installation = await call("GET", `/repos/${repository}/installation`, { auth: jwt });
    const t = await call("POST", `/app/installations/${installation.id}/access_tokens`, { auth: jwt });
    token = { value: t.token, expiresAt: new Date(t.expires_at).getTime() };
    return token.value;
  }

  return {
    /** Queued jobs of queued workflow runs (the grader's workflow has one job). */
    async queuedJobs() {
      const runs = await call("GET", `/repos/${repository}/actions/runs?status=queued&per_page=100`);
      const jobs = [];
      for (const run of runs.workflow_runs ?? []) {
        const page = await call("GET", `/repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
        for (const job of page.jobs ?? []) {
          if (job.status === "queued") jobs.push({ id: job.id, labels: job.labels ?? [] });
        }
      }
      return jobs;
    },
    async runners() {
      const page = await call("GET", `/repos/${repository}/actions/runners?per_page=100`);
      return (page.runners ?? []).map((r) => ({ id: r.id, name: r.name, status: r.status, busy: r.busy }));
    },
    async jitConfig(name, labels) {
      const res = await call("POST", `/repos/${repository}/actions/runners/generate-jitconfig`, {
        body: { name, runner_group_id: 1, labels, work_folder: "_work" },
      });
      return { runnerId: res.runner.id, config: res.encoded_jit_config };
    },
    async deleteRunner(id) {
      await call("DELETE", `/repos/${repository}/actions/runners/${id}`);
    },
  };
}
