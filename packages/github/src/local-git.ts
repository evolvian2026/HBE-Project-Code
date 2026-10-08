import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { GitHubError, type CommitTree, type Comparison, type FileChangeDetail } from "./client.ts";

const exec = promisify(execFile);

/**
 * Local development and tests: repositories `owner/name` are git repositories at
 * `<root>/<owner>/<name>`, read with the git CLI. Gives the in-memory GitHub real code.
 */
export class LocalGitRepos {
  constructor(private readonly root: string) {}

  private dir(owner: string, repo: string): string {
    if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) throw new GitHubError(404, "Not Found", false);
    const dir = path.join(this.root, owner, repo);
    if (!existsSync(dir)) throw new GitHubError(404, `No local repository ${owner}/${repo}`, false);
    return dir;
  }

  private async git(owner: string, repo: string, args: string[], encoding: "utf8" | "buffer" = "utf8") {
    const sanitized = args.map((a) => {
      if (a.startsWith("-") && !/^--?[\w-]+(=.*)?$/.test(a)) throw new GitHubError(422, "Bad argument", false);
      return a;
    });
    try {
      const { stdout } = await exec("git", ["-C", this.dir(owner, repo), ...sanitized], {
        encoding: encoding === "buffer" ? "buffer" : "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      return stdout as string | Buffer;
    } catch (err) {
      if (err instanceof GitHubError) throw err;
      throw new GitHubError(404, `git ${args[0]} failed: ${(err as Error).message.split("\n")[0]}`, false);
    }
  }

  private static ref(ref: string): string {
    if (!/^[\w./-]+$/.test(ref) || ref.startsWith("-")) throw new GitHubError(422, "Bad ref", false);
    return ref;
  }

  async tree(owner: string, repo: string, sha: string): Promise<CommitTree> {
    const commit = String(await this.git(owner, repo, ["rev-parse", `${LocalGitRepos.ref(sha)}^{commit}`])).trim();
    const out = String(await this.git(owner, repo, ["ls-tree", "-r", "-t", "-l", "-z", commit]));
    const entries = out
      .split("\0")
      .filter(Boolean)
      .map((line) => {
        const [meta, filePath] = line.split("\t") as [string, string];
        const [, type, objectSha, size] = meta.split(/\s+/) as [string, "blob" | "tree" | "commit", string, string];
        return { path: filePath, type, sha: objectSha, size: type === "blob" ? Number(size) : null };
      });
    return { sha: commit, entries, truncated: false };
  }

  async blob(owner: string, repo: string, blobSha: string): Promise<Buffer> {
    if (!/^[0-9a-f]{40}$/.test(blobSha)) throw new GitHubError(404, "Not Found", false);
    return (await this.git(owner, repo, ["cat-file", "blob", blobSha], "buffer")) as Buffer;
  }

  async compare(owner: string, repo: string, base: string, head: string): Promise<Comparison> {
    const range = [LocalGitRepos.ref(base), LocalGitRepos.ref(head)];
    const [count, numstat, status, patch] = await Promise.all([
      this.git(owner, repo, ["rev-list", "--count", `${range[0]}..${range[1]}`]),
      this.git(owner, repo, ["diff", "--numstat", "-M", ...range]),
      this.git(owner, repo, ["diff", "--name-status", "-M", ...range]),
      this.git(owner, repo, ["diff", "--no-color", "-M", "--no-ext-diff", ...range]),
    ]);
    const STATUS: Record<string, FileChangeDetail["status"]> = {
      A: "added",
      D: "removed",
      M: "modified",
      R: "renamed",
      C: "copied",
      T: "changed",
    };
    const patches = new Map<string, string>();
    for (const chunk of String(patch)
      .split(/^diff --git /m)
      .slice(1)) {
      const name = /^\+\+\+ b\/(.+)$/m.exec(chunk)?.[1] ?? /^--- a\/(.+)$/m.exec(chunk)?.[1];
      const hunks = chunk.indexOf("\n@@");
      if (name && hunks >= 0) patches.set(name, chunk.slice(hunks + 1).trimEnd());
    }
    const stats = String(numstat)
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split("\t"));
    const files = String(status)
      .split("\n")
      .filter(Boolean)
      .map((line, i) => {
        const [code, ...names] = line.split("\t");
        const filename = names[names.length - 1]!;
        const [add, del] = stats[i] ?? ["0", "0"];
        return {
          filename,
          ...(names.length > 1 ? { previousFilename: names[0] } : {}),
          status: STATUS[code![0]!] ?? "changed",
          additions: add === "-" ? 0 : Number(add),
          deletions: del === "-" ? 0 : Number(del),
          ...(patches.has(filename) ? { patch: patches.get(filename) } : {}),
        };
      });
    return { totalCommits: Number(String(count).trim()), files, truncated: false };
  }

  async rootCommit(owner: string, repo: string, ref: string): Promise<string> {
    const out = String(await this.git(owner, repo, ["rev-list", "--max-parents=0", LocalGitRepos.ref(ref)]));
    const roots = out.trim().split("\n");
    return roots[roots.length - 1]!;
  }
}
