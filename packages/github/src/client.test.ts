import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { appJwt, GitHubAppClient, GitHubError } from "./client.ts";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
// GitHub issues PKCS#1 keys ("BEGIN RSA PRIVATE KEY").
const pkcs1 = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

interface Recorded {
  method: string;
  url: string;
  auth: string | null;
  body: unknown;
}

/** A fetch that records requests and answers from a route table. */
function mockFetch(
  routes: Record<string, (body: unknown) => { status: number; json?: unknown; headers?: Record<string, string> }>,
) {
  const calls: Recorded[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input).replace("https://api.github.test", "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, auth: new Headers(init?.headers).get("authorization"), body });
    const handler = routes[`${method} ${url}`];
    const out = handler ? handler(body) : { status: 404, json: { message: "Not Found" } };
    return new Response(out.json === undefined ? null : JSON.stringify(out.json), {
      status: out.status,
      headers: out.headers,
    });
  }) as typeof fetch;
  return { impl, calls };
}

const repoJson = (name: string) => ({
  id: 42,
  name,
  owner: { login: "alpha-cs" },
  default_branch: "main",
  private: true,
});

describe("appJwt", () => {
  it("signs an RS256 JWT GitHub accepts (iss, iat backdated, exp within 10 min)", () => {
    const jwt = appJwt("12345", privateKey, Date.parse("2026-10-08T00:00:00Z"));
    const [h, p, s] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const payload = JSON.parse(Buffer.from(p!, "base64url").toString());
    expect(payload.iss).toBe("12345");
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(600);
    const ok = createVerify("RSA-SHA256")
      .update(`${h}.${p}`)
      .verify(createPublicKey(privateKey), Buffer.from(s!, "base64url"));
    expect(ok).toBe(true);
  });
});

describe("GitHubAppClient", () => {
  it("dispatches workflows, posts check runs and finds a repo's installation", async () => {
    const { impl, calls } = mockFetch({
      "GET /repos/hbe-platform/hbe-grader/installation": () => ({ status: 200, json: { id: 7 } }),
      "POST /app/installations/7/access_tokens": () => ({
        status: 201,
        json: { token: "ghs_x", expires_at: "2099-01-01T00:00:00Z" },
      }),
      "POST /repos/hbe-platform/hbe-grader/actions/workflows/evaluate.yml/dispatches": () => ({ status: 204 }),
      "POST /repos/alpha-cs/r/check-runs": () => ({ status: 201, json: { id: 555 } }),
    });
    const client = new GitHubAppClient({
      appId: "1",
      privateKey: pkcs1,
      apiUrl: "https://api.github.test",
      fetch: impl,
    });
    const id = await client.installationIdForRepo("hbe-platform", "hbe-grader");
    expect(id).toBe(7);
    await client.installationIdForRepo("hbe-platform", "hbe-grader"); // cached
    const gh = client.forInstallation(id);
    await gh.dispatchWorkflow("hbe-platform", "hbe-grader", "evaluate.yml", "main", { run_id: "r1" });
    expect(
      await gh.createCheckRun("alpha-cs", "r", {
        name: "HBE tests",
        headSha: "a".repeat(40),
        conclusion: "failure",
        title: "1/2",
        summary: "s",
      }),
    ).toBe(555);
    expect(calls.filter((c) => c.url.endsWith("/installation"))).toHaveLength(1);
    expect(calls.find((c) => c.url.endsWith("/dispatches"))?.body).toEqual({ ref: "main", inputs: { run_id: "r1" } });
    expect(calls.find((c) => c.url.endsWith("/check-runs"))?.body).toMatchObject({
      status: "completed",
      conclusion: "failure",
      output: { title: "1/2" },
    });
  });

  const tokenRoute = {
    "POST /app/installations/7/access_tokens": () => ({
      status: 201,
      json: { token: "ghs_installation", expires_at: "2026-10-08T01:00:00Z" },
    }),
  };

  it("exchanges the App JWT for an installation token, caches it, and creates repos from templates", async () => {
    const { impl, calls } = mockFetch({
      ...tokenRoute,
      "POST /repos/hbe-templates/mern-starter/generate": () => ({ status: 201, json: repoJson("todo-api-ada") }),
      "PUT /repos/alpha-cs/todo-api-ada/collaborators/ada": () => ({ status: 201, json: { id: 1 } }),
    });
    let now = Date.parse("2026-10-08T00:00:00Z");
    const client = new GitHubAppClient({
      appId: "1",
      privateKey: pkcs1,
      apiUrl: "https://api.github.test",
      fetch: impl,
      now: () => now,
    });
    const gh = client.forInstallation(7);

    const repo = await gh.createRepoFromTemplate({
      templateOwner: "hbe-templates",
      templateRepo: "mern-starter",
      owner: "alpha-cs",
      name: "todo-api-ada",
      description: "Todo API — Ada",
    });
    expect(repo).toEqual({ id: 42, owner: "alpha-cs", name: "todo-api-ada", defaultBranch: "main", private: true });
    expect(await gh.addCollaborator("alpha-cs", "todo-api-ada", "ada", "push")).toBe("invited");

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST /app/installations/7/access_tokens",
      "POST /repos/hbe-templates/mern-starter/generate",
      "PUT /repos/alpha-cs/todo-api-ada/collaborators/ada",
    ]);
    expect(calls[0]!.auth).toMatch(/^Bearer ey/); // the App JWT
    expect(calls[1]!.auth).toBe("Bearer ghs_installation");
    expect(calls[1]!.body).toMatchObject({ owner: "alpha-cs", name: "todo-api-ada", private: true });

    // Within 5 minutes of expiry the token is refreshed.
    now = Date.parse("2026-10-08T00:56:00Z");
    await gh.addCollaborator("alpha-cs", "todo-api-ada", "ada", "push");
    expect(calls.filter((c) => c.url.endsWith("access_tokens"))).toHaveLength(2);
  });

  it("returns null for a missing repo and 'added' when access already existed", async () => {
    const { impl } = mockFetch({
      ...tokenRoute,
      "PUT /repos/alpha-cs/r/collaborators/grace": () => ({ status: 204 }),
    });
    const gh = new GitHubAppClient({
      appId: "1",
      privateKey: pkcs1,
      apiUrl: "https://api.github.test",
      fetch: impl,
    }).forInstallation(7);
    expect(await gh.getRepo("alpha-cs", "nope")).toBeNull();
    expect(await gh.addCollaborator("alpha-cs", "r", "grace", "push")).toBe("added");
  });

  it("classifies errors: validation is permanent, outages and rate limits are retryable", async () => {
    const { impl } = mockFetch({
      ...tokenRoute,
      "POST /repos/t/a/generate": () => ({
        status: 422,
        json: { message: "Validation Failed", errors: [{ message: "Name already exists on this account" }] },
      }),
      "POST /repos/t/b/generate": () => ({ status: 502, json: { message: "Bad gateway" } }),
      "POST /repos/t/c/generate": () => ({
        status: 403,
        json: { message: "API rate limit exceeded" },
        headers: { "x-ratelimit-remaining": "0" },
      }),
    });
    const gh = new GitHubAppClient({
      appId: "1",
      privateKey: pkcs1,
      apiUrl: "https://api.github.test",
      fetch: impl,
    }).forInstallation(7);
    const attempt = (repo: string) =>
      gh
        .createRepoFromTemplate({ templateOwner: "t", templateRepo: repo, owner: "o", name: "n", description: "" })
        .catch((e: unknown) => e);

    const permanent = (await attempt("a")) as GitHubError;
    expect(permanent).toBeInstanceOf(GitHubError);
    expect(permanent.retryable).toBe(false);
    expect(permanent.message).toContain("Name already exists on this account");
    expect(((await attempt("b")) as GitHubError).retryable).toBe(true);
    expect(((await attempt("c")) as GitHubError).retryable).toBe(true);
  });
});
