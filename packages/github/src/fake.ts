import {
  GitHubError,
  type CheckRunInput,
  type CommitDetails,
  type GitHubClient,
  type InstallationClient,
  type RepoInfo,
} from "./client.ts";
import { LocalGitRepos } from "./local-git.ts";

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
  readonly dispatches: {
    owner: string;
    repo: string;
    workflowFile: string;
    ref: string;
    inputs: Record<string, string>;
  }[] = [];
  readonly checkRuns: (CheckRunInput & { owner: string; repo: string; id: number })[] = [];

  async installationIdForRepo(_owner: string, _repo: string): Promise<number> {
    return 1;
  }
  /** Repository ids are unique across instances, as on GitHub. */
  private static nextId = 1_000_000 + Math.floor(Math.random() * 1_000_000_000);

  private readonly git: LocalGitRepos | null;

  /**
   * `permissive`: every template exists (local development without a GitHub App).
   * `gitRoot`: code is read from git repositories at `<gitRoot>/<owner>/<name>`.
   */
  constructor(private readonly options: { permissive?: boolean; gitRoot?: string } = {}) {
    this.git = options.gitRoot ? new LocalGitRepos(options.gitRoot) : null;
  }

  private localGit(): LocalGitRepos {
    if (!this.git) throw new GitHubError(404, "Code is not available without GITHUB_FAKE_GIT_ROOT", false);
    return this.git;
  }

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
      dispatchWorkflow: async (owner, repo, workflowFile, ref, inputs) => {
        this.calls.push(`dispatchWorkflow ${owner}/${repo} ${workflowFile}@${ref}`);
        fail();
        this.dispatches.push({ owner, repo, workflowFile, ref, inputs });
      },
      createCheckRun: async (owner, repo, check) => {
        this.calls.push(`createCheckRun ${owner}/${repo} ${check.headSha.slice(0, 7)}`);
        fail();
        const id = FakeGitHub.nextId++;
        this.checkRuns.push({ ...check, owner, repo, id });
        return id;
      },
      getTree: async (owner, repo, sha) => {
        this.calls.push(`getTree ${owner}/${repo}@${sha.slice(0, 7)}`);
        fail();
        return this.localGit().tree(owner, repo, sha);
      },
      getBlob: async (owner, repo, blobSha) => {
        this.calls.push(`getBlob ${owner}/${repo} ${blobSha.slice(0, 7)}`);
        fail();
        return this.localGit().blob(owner, repo, blobSha);
      },
      compare: async (owner, repo, base, head) => {
        this.calls.push(`compare ${owner}/${repo} ${base.slice(0, 7)}...${head.slice(0, 7)}`);
        fail();
        return this.localGit().compare(owner, repo, base, head);
      },
      rootCommit: async (owner, repo, ref) => {
        this.calls.push(`rootCommit ${owner}/${repo}`);
        fail();
        return this.localGit().rootCommit(owner, repo, ref);
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
      listCollaborators: async (owner, repo) => {
        this.calls.push(`listCollaborators ${owner}/${repo}`);
        fail();
        return [...(this.collaborators.get(`${owner}/${repo}`.toLowerCase())?.keys() ?? [])];
      },
      removeCollaborator: async (owner, repo, username) => {
        this.calls.push(`removeCollaborator ${owner}/${repo} ${username}`);
        fail();
        this.collaborators.get(`${owner}/${repo}`.toLowerCase())?.delete(username.toLowerCase());
      },
    };
  }
}
