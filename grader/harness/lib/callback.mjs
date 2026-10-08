import { setTimeout as sleep } from "node:timers/promises";

/**
 * Talks to the platform API. In GitHub Actions it authenticates with a fresh OIDC token per
 * call (audience = the API URL); in local development with the run's callback token.
 * The OIDC request credentials are taken out of the environment at startup so nothing the
 * harness starts can inherit them.
 */
export function createCallbacks({ apiUrl, runId, token }) {
  const oidcUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const oidcBearer = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  delete process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!token && !(oidcUrl && oidcBearer)) {
    throw new Error("No callback credentials: pass --token, or run in GitHub Actions with `id-token: write`");
  }

  async function credential() {
    if (token) return token;
    const res = await fetch(`${oidcUrl}&audience=${encodeURIComponent(apiUrl)}`, {
      headers: { authorization: `Bearer ${oidcBearer}` },
    });
    if (!res.ok) throw new Error(`Could not get an OIDC token: HTTP ${res.status}`);
    return (await res.json()).value;
  }

  /** POSTs with retries on network errors and 5xx; a 4xx is final. */
  async function post(path, body, attempts = 4) {
    const url = new URL(`/v1/runs/${runId}/${path}`, apiUrl);
    for (let attempt = 1; ; attempt++) {
      let res;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${await credential()}`, "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        if (attempt >= attempts) throw new Error(`POST ${url.pathname} failed: ${err.message}`);
        await sleep(2000 * attempt);
        continue;
      }
      if (res.ok) return res.json().catch(() => ({}));
      const text = await res.text().catch(() => "");
      if (res.status < 500 || attempt >= attempts) {
        throw new Error(`POST ${url.pathname} answered ${res.status}: ${text.slice(0, 300)}`);
      }
      await sleep(2000 * attempt);
    }
  }

  return {
    started: () => post("started", {}),
    /** Signed upload URLs for the source snapshot (graded runs), or `{}`. */
    snapshotUploads: () => post("snapshot-uploads", {}),
    results: (results) => post("results", results, 6),
  };
}
