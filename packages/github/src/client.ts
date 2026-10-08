import { createPrivateKey, createSign, type KeyObject } from "node:crypto";

/** A GitHub REST error. `retryable` separates outages and rate limits from permanent failures. */
export class GitHubError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(status: number, message: string, retryable: boolean) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
    this.retryable = retryable;
  }
}

export interface CommitDetails {
  sha: string;
  /** The GitHub user GitHub matched to the commit's author email, if any. */
  authorId: number | null;
  authorLogin: string | null;
  authorIsBot: boolean;
  parentCount: number;
  additions: number;
  deletions: number;
  files: { filename: string; additions: number; deletions: number; patch?: string }[];
}

export interface RepoInfo {
  id: number;
  owner: string;
  name: string;
  defaultBranch: string;
  private: boolean;
}

/** Everything the platform does on an organisation, as one installation of the App. */
export interface InstallationClient {
  getRepo(owner: string, name: string): Promise<RepoInfo | null>;
  createRepoFromTemplate(input: {
    templateOwner: string;
    templateRepo: string;
    owner: string;
    name: string;
    description: string;
  }): Promise<RepoInfo>;
  getCommit(owner: string, repo: string, sha: string): Promise<CommitDetails>;
  /** Starts a workflow_dispatch run (GitHub returns no run id). */
  dispatchWorkflow(
    owner: string,
    repo: string,
    workflowFile: string,
    ref: string,
    inputs: Record<string, string>,
  ): Promise<void>;
  createCheckRun(owner: string, repo: string, check: CheckRunInput): Promise<number>;
  /** `invited`: GitHub emailed an invitation; `added`: they already had access (org member). */
  addCollaborator(
    owner: string,
    repo: string,
    username: string,
    permission: "push" | "pull",
  ): Promise<"invited" | "added">;
}

export interface CheckRunInput {
  name: string;
  headSha: string;
  conclusion: "success" | "failure" | "neutral";
  title: string;
  summary: string;
  detailsUrl?: string;
}

export interface GitHubClient {
  forInstallation(installationId: number): InstallationClient;
  /** The App's installation id for a repository (e.g. the grader repository). */
  installationIdForRepo(owner: string, repo: string): Promise<number>;
}

export interface GitHubAppCredentials {
  appId: string;
  /** PEM (PKCS#1 as GitHub issues it, or PKCS#8). */
  privateKey: string;
  apiUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

const base64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");

/** RS256 JWT identifying the App (valid ~9 minutes; GitHub allows at most 10). */
export function appJwt(appId: string, key: KeyObject, nowMs: number): string {
  const now = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(key);
  return `${header}.${payload}.${base64url(signature)}`;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

/** REST client for a GitHub App, using fetch. Installation tokens are cached until 5 min before expiry. */
export class GitHubAppClient implements GitHubClient {
  private readonly key: KeyObject;
  private readonly apiUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly tokens = new Map<number, CachedToken>();

  constructor(private readonly creds: GitHubAppCredentials) {
    this.key = createPrivateKey(creds.privateKey);
    this.apiUrl = (creds.apiUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.fetchImpl = creds.fetch ?? fetch;
    this.now = creds.now ?? Date.now;
  }

  private readonly repoInstallations = new Map<string, number>();

  async installationIdForRepo(owner: string, repo: string): Promise<number> {
    const key = `${owner}/${repo}`.toLowerCase();
    const cached = this.repoInstallations.get(key);
    if (cached) return cached;
    const res = await this.send(
      "GET",
      `/repos/${enc(owner)}/${enc(repo)}/installation`,
      appJwt(this.creds.appId, this.key, this.now()),
    );
    const { id } = (await res.json()) as { id: number };
    this.repoInstallations.set(key, id);
    return id;
  }

  forInstallation(installationId: number): InstallationClient {
    const call = <T>(method: string, path: string, body?: unknown) =>
      this.request<T>(installationId, method, path, body);
    return {
      getRepo: async (owner, name) => {
        try {
          return toRepo(await call<RepoJson>("GET", `/repos/${enc(owner)}/${enc(name)}`));
        } catch (err) {
          if (err instanceof GitHubError && err.status === 404) return null;
          throw err;
        }
      },
      createRepoFromTemplate: async ({ templateOwner, templateRepo, owner, name, description }) =>
        toRepo(
          await call<RepoJson>("POST", `/repos/${enc(templateOwner)}/${enc(templateRepo)}/generate`, {
            owner,
            name,
            description,
            private: true,
            include_all_branches: false,
          }),
        ),
      getCommit: async (owner, repo, sha) => {
        const c = await call<CommitJson>("GET", `/repos/${enc(owner)}/${enc(repo)}/commits/${enc(sha)}`);
        return {
          sha: c.sha,
          authorId: c.author?.id ?? null,
          authorLogin: c.author?.login ?? null,
          authorIsBot: c.author?.type === "Bot" || /\[bot\]$/.test(c.author?.login ?? ""),
          parentCount: c.parents.length,
          additions: c.stats?.additions ?? 0,
          deletions: c.stats?.deletions ?? 0,
          files: (c.files ?? []).map((f) => ({
            filename: f.filename,
            additions: f.additions,
            deletions: f.deletions,
            patch: f.patch,
          })),
        };
      },
      dispatchWorkflow: async (owner, repo, workflowFile, ref, inputs) => {
        await call<null>(
          "POST",
          `/repos/${enc(owner)}/${enc(repo)}/actions/workflows/${enc(workflowFile)}/dispatches`,
          { ref, inputs },
        );
      },
      createCheckRun: async (owner, repo, check) => {
        const res = await call<{ id: number }>("POST", `/repos/${enc(owner)}/${enc(repo)}/check-runs`, {
          name: check.name,
          head_sha: check.headSha,
          status: "completed",
          conclusion: check.conclusion,
          details_url: check.detailsUrl,
          output: { title: check.title.slice(0, 255), summary: check.summary.slice(0, 65_000) },
        });
        return res.id;
      },
      addCollaborator: async (owner, repo, username, permission) => {
        const result = await call<unknown>("PUT", `/repos/${enc(owner)}/${enc(repo)}/collaborators/${enc(username)}`, {
          permission,
        });
        return result === null ? "added" : "invited";
      },
    };
  }

  private async installationToken(installationId: number): Promise<string> {
    const cached = this.tokens.get(installationId);
    if (cached && cached.expiresAt - 5 * 60_000 > this.now()) return cached.token;
    const res = await this.send(
      "POST",
      `/app/installations/${installationId}/access_tokens`,
      appJwt(this.creds.appId, this.key, this.now()),
    );
    const json = (await res.json()) as { token: string; expires_at: string };
    this.tokens.set(installationId, { token: json.token, expiresAt: Date.parse(json.expires_at) });
    return json.token;
  }

  private async request<T>(installationId: number, method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.installationToken(installationId);
    const res = await this.send(method, path, token, body);
    if (res.status === 204) return null as T;
    return (await res.json()) as T;
  }

  private async send(method: string, path: string, bearer: string, body?: unknown): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.apiUrl}${path}`, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${bearer}`,
          "user-agent": "hbe-platform",
          "x-github-api-version": "2022-11-28",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new GitHubError(0, `GitHub unreachable: ${err instanceof Error ? err.message : String(err)}`, true);
    }
    if (res.ok) return res;

    const text = await res.text();
    let message = text.slice(0, 500);
    try {
      const json = JSON.parse(text) as { message?: string; errors?: { message?: string }[] };
      message = [json.message, ...(json.errors ?? []).map((e) => e.message)].filter(Boolean).join(": ");
    } catch {
      // not JSON
    }
    const rateLimited =
      res.status === 429 ||
      (res.status === 403 && (res.headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(message)));
    throw new GitHubError(
      res.status,
      `GitHub ${method} ${path} → ${res.status}: ${message}`,
      rateLimited || res.status >= 500,
    );
  }
}

interface CommitJson {
  sha: string;
  author: { id: number; login: string; type: string } | null;
  parents: unknown[];
  stats?: { additions: number; deletions: number };
  files?: { filename: string; additions: number; deletions: number; patch?: string }[];
}

interface RepoJson {
  id: number;
  name: string;
  owner: { login: string };
  default_branch: string;
  private: boolean;
}

const toRepo = (r: RepoJson): RepoInfo => ({
  id: r.id,
  owner: r.owner.login,
  name: r.name,
  defaultBranch: r.default_branch,
  private: r.private,
});

const enc = encodeURIComponent;
