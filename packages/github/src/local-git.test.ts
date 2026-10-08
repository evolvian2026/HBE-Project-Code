import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FakeGitHub } from "./fake.ts";

const root = mkdtempSync(path.join(tmpdir(), "hbe-local-git-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const repo = path.join(root, "org", "todo-api-ada");
mkdirSync(repo, { recursive: true });
const git = (...args: string[]) =>
  execFileSync("git", ["-C", repo, "-c", "user.name=Ada", "-c", "user.email=ada@example.test", ...args], {
    encoding: "utf8",
  }).trim();
git("init", "-q", "-b", "main");
mkdirSync(path.join(repo, "src"));
writeFileSync(path.join(repo, "README.md"), "# Todo API\n");
writeFileSync(path.join(repo, "src", "server.js"), "export const port = 4000;\n");
git("add", ".");
git("commit", "-q", "-m", "Template");
const template = git("rev-parse", "HEAD");
writeFileSync(path.join(repo, "src", "server.js"), "export const port = 4000;\nexport const todos = [];\n");
git("mv", "README.md", "NOTES.md");
git("commit", "-q", "-am", "Add todos");
const head = git("rev-parse", "HEAD");

describe("FakeGitHub with local git repositories", () => {
  const gh = new FakeGitHub({ gitRoot: root }).forInstallation(1);

  it("lists the tree and reads files at a commit", async () => {
    const tree = await gh.getTree("org", "todo-api-ada", head);
    expect(tree.sha).toBe(head);
    expect(tree.entries.map((e) => [e.path, e.type])).toEqual([
      ["NOTES.md", "blob"],
      ["src", "tree"],
      ["src/server.js", "blob"],
    ]);
    const file = tree.entries.find((e) => e.path === "src/server.js")!;
    expect(file.size).toBe(51);
    expect((await gh.getBlob("org", "todo-api-ada", file.sha)).toString()).toContain("todos");
  });

  it("compares commits and finds where the student started", async () => {
    expect(await gh.rootCommit("org", "todo-api-ada", head)).toBe(template);
    const diff = await gh.compare("org", "todo-api-ada", template, head);
    expect(diff.totalCommits).toBe(1);
    expect(diff.files).toEqual([
      { filename: "NOTES.md", previousFilename: "README.md", status: "renamed", additions: 0, deletions: 0 },
      {
        filename: "src/server.js",
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: expect.stringContaining("+export const todos = [];"),
      },
    ]);
  });

  it("refuses unknown repositories and odd refs", async () => {
    await expect(gh.getTree("org", "missing", head)).rejects.toMatchObject({ status: 404 });
    await expect(gh.getTree("org", "todo-api-ada", "--output=/tmp/x")).rejects.toMatchObject({ status: 422 });
    await expect(gh.getTree("..", "todo-api-ada", head)).rejects.toMatchObject({ status: 404 });
  });
});
