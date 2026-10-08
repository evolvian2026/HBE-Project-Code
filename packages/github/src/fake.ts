import {
  GitHubError,
  type CommitDetails,
  type GitHubClient,
  type InstallationClient,
  type RepoInfo,
} from "./client.ts";

/**
 * In-memory GitHub for tests and local development without a GitHub App.
 * Behaves like the parts of the REST API the platform uses, including errors.
 */
export class FakeGitHub implements GitHubClient {
  readonly repos = new Map<string, RepoInfo & { installationId: number; template: string | null }>();
  readonly collaborators = new Map<string, Map<string, "push" | "pull">>();
  /** Template repositories that exist, as "owner/name". */
  readonly templates = new Set<string>();
  /** Queue of errors to throw on the next calls (to test retries). */
  readonly failures: GitHubError[] = [];
  readonly calls: string[] = [];
  /** Commit details keyed by "owner/repo@sha" (lowercase owner/repo). */
  readonly commits = new Map<string, CommitDetails>();
  /** Repository ids are unique across instances, as on GitHub. */
  private static nextId = 1_000_000 + Math.floor(Math.random() * 1_000_000_000);

  /** `permissive`: every template exists (local development without a GitHub App). */
  constructor(private readonly options: { permissive?: boolean } = {}) {}

  forInstallation(installationId: number): InstallationClient {
    const fail = () => {
      const err = this.failures.shift();
      if (err) throw err;
    };
    return {
      getRepo: async (owner, name) => {
        this.calls.push(`getRepo ${owner}/${name}`);
        fail();
        return this.repos.get(`${owner}/${name}`.toLowerCase()) ?? null;
      },
      createRepoFromTemplate: async ({ templateOwner, templateRepo, owner, name }) => {
        this.calls.push(`createRepoFromTemplate ${templateOwner}/${templateRepo} → ${owner}/${name}`);
        fail();
        const template = `${templateOwner}/${templateRepo}`;
        if (!this.options.permissive && !this.templates.has(template)) {
          throw new GitHubError(404, `Template ${template} not found`, false);
        }
        const key = `${owner}/${name}`.toLowerCase();
        if (this.repos.has(key)) throw new GitHubError(422, "Name already exists on this account", false);
        const repo = {
          id: FakeGitHub.nextId++,
          owner,
          name,
          defaultBranch: "main",
          private: true,
          installationId,
          template,
        };
        this.repos.set(key, repo);
        return repo;
      },
      getCommit: async (owner, repo, sha) => {
        this.calls.push(`getCommit ${owner}/${repo}@${sha.slice(0, 7)}`);
        fail();
        const commit = this.commits.get(`${owner}/${repo}@${sha}`.toLowerCase());
        if (!commit) throw new GitHubError(404, "No commit found for SHA", false);
        return commit;
      },
      addCollaborator: async (owner, repo, username, permission) => {
        this.calls.push(`addCollaborator ${owner}/${repo} ${username}`);
        fail();
        const key = `${owner}/${repo}`.toLowerCase();
        if (!this.repos.has(key)) throw new GitHubError(404, "Not Found", false);
        const members = this.collaborators.get(key) ?? new Map();
        const existed = members.has(username.toLowerCase());
        members.set(username.toLowerCase(), permission);
        this.collaborators.set(key, members);
        return existed ? "added" : "invited";
      },
    };
  }
}
