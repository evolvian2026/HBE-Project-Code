import { formatInZone } from "@hbe/core";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Alert, Badge, Button, Card, EmptyState } from "@/components/ui";
import { apiFetch } from "@/lib/api";
import { deleteReviewComment } from "../../../../actions";
import { loadAssignment } from "../../../../data";
import { teamSubmissionIds } from "@/lib/team";
import { CommentForm } from "./comment-form";

export const metadata: Metadata = { title: "Review code" };

type Props = {
  params: Promise<{ slug: string; courseId: string; assignmentId: string; submissionId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
};

interface TreeEntry {
  path: string;
  type: "blob" | "tree";
  size: number | null;
}
interface FileView {
  path: string;
  sha: string;
  size: number;
  binary: boolean;
  tooLarge: boolean;
  content: string | null;
}
interface Comparison {
  base: string;
  head: string;
  totalCommits: number;
  truncated: boolean;
  files: {
    filename: string;
    previousFilename?: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;
  }[];
}
interface Comment {
  id: string;
  sha: string;
  path: string;
  line: number;
  body: string;
  author_id: string | null;
  created_at: string;
  author: { full_name: string | null; email: string | null } | null;
}

const SHA = /^[0-9a-f]{40}$/;

/** Nested folders from flat paths; folders on the way to `open` start expanded. */
function FileTree({ entries, href, open }: { entries: TreeEntry[]; href: (path: string) => string; open?: string }) {
  type Node = { name: string; path: string; children: Map<string, Node>; file: boolean };
  const root: Node = { name: "", path: "", children: new Map(), file: false };
  for (const e of entries) {
    let node = root;
    const parts = e.path.split("/");
    parts.forEach((part, i) => {
      const p = parts.slice(0, i + 1).join("/");
      if (!node.children.has(part)) node.children.set(part, { name: part, path: p, children: new Map(), file: false });
      node = node.children.get(part)!;
      if (i === parts.length - 1 && e.type === "blob") node.file = true;
    });
  }
  const sorted = (n: Node) =>
    [...n.children.values()].sort((a, b) => Number(a.file) - Number(b.file) || a.name.localeCompare(b.name));
  const render = (n: Node) => (
    <ul className="space-y-0.5 pl-3">
      {sorted(n).map((c) =>
        c.file ? (
          <li key={c.path}>
            <Link
              href={href(c.path)}
              className={`block truncate rounded px-1 hover:bg-surface-2 ${c.path === open ? "bg-accent/10 font-medium" : ""}`}
            >
              {c.name}
            </Link>
          </li>
        ) : (
          <li key={c.path}>
            <details open={Boolean(open?.startsWith(`${c.path}/`))}>
              <summary className="cursor-pointer px-1 text-muted">{c.name}/</summary>
              {render(c)}
            </details>
          </li>
        ),
      )}
    </ul>
  );
  return (
    <div className="-ml-3 font-mono text-xs" data-testid="file-tree">
      {render(root)}
    </div>
  );
}

export default async function ReviewCodePage({ params, searchParams }: Props) {
  const { slug, courseId, assignmentId, submissionId } = await params;
  const q = await searchParams;
  const { course, supabase, isCourseStaff, assignment: a, ctx } = await loadAssignment(slug, courseId, assignmentId);
  if (!isCourseStaff || !/^[0-9a-f-]{36}$/.test(submissionId)) notFound();

  const base = `/i/${slug}/courses/${course.id}/assignments/${a.id}/submissions/${submissionId}`;
  const { data: submission } = await supabase
    .from("submissions")
    .select("final_sha, team_id, profile:profiles(full_name, email), repository:repositories(owner, name, head_sha)")
    .eq("id", submissionId)
    .maybeSingle();
  if (!submission) notFound();
  // A team's code is reviewed once: comments on any member's submission show for all.
  const teamIds = await teamSubmissionIds(supabase, {
    id: submissionId,
    assignment_id: a.id,
    team_id: (submission as { team_id: string | null }).team_id,
  });
  const sub = submission as unknown as {
    final_sha: string | null;
    profile: { full_name: string | null; email: string | null } | null;
    repository: { owner: string; name: string; head_sha: string | null } | null;
  };

  const sha = q.sha && SHA.test(q.sha) ? q.sha : undefined;
  const view = q.view === "changes" ? "changes" : "files";
  const tree = await apiFetch<{ sha: string; truncated: boolean; entries: TreeEntry[] }>(
    `/v1/submissions/${submissionId}/code/tree${sha ? `?sha=${sha}` : ""}`,
  );
  const current = tree.ok ? tree.data.sha : sha;
  const [file, diff, comments] = await Promise.all([
    view === "files" && q.path && current
      ? apiFetch<FileView>(
          `/v1/submissions/${submissionId}/code/file?sha=${current}&path=${encodeURIComponent(q.path)}`,
        )
      : Promise.resolve(null),
    view === "changes" && current
      ? apiFetch<Comparison>(`/v1/submissions/${submissionId}/code/compare?head=${current}`)
      : Promise.resolve(null),
    supabase
      .from("review_comments")
      .select("id, sha, path, line, body, author_id, created_at, author:profiles(full_name, email)")
      .in("submission_id", teamIds)
      .order("path")
      .order("line"),
  ]);
  const allComments = (comments.data ?? []) as unknown as Comment[];
  const here = allComments.filter((c) => c.sha === current && c.path === q.path);
  const line = q.line ? Number(q.line) : null;
  const link = (params: Record<string, string | undefined>) => {
    const sp = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]);
    return `${base}/code?${sp}`;
  };
  const shaLinks = [
    sub.final_sha && { label: "Graded commit", sha: sub.final_sha },
    sub.repository?.head_sha && { label: "Latest push", sha: sub.repository.head_sha },
  ].filter(Boolean) as { label: string; sha: string }[];
  const ids = { slug, courseId: course.id, assignmentId: a.id, submissionId };

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-muted">
          <Link href={base} className="hover:text-text">
            {a.title} · {sub.profile?.full_name ?? sub.profile?.email}
          </Link>
        </p>
        <h2 className="mt-1 text-xl font-semibold">Review code</h2>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
          {current && <span className="font-mono">{current.slice(0, 7)}</span>}
          {shaLinks.map((s) => (
            <Link
              key={s.label}
              href={link({ sha: s.sha, path: q.path, view })}
              className={`rounded border px-2 py-0.5 ${s.sha === current ? "border-accent text-text" : "border-border hover:text-text"}`}
            >
              {s.label}
            </Link>
          ))}
          <span className="mx-1">·</span>
          <Link
            href={link({ sha: current, path: q.path })}
            className={view === "files" ? "font-medium text-text" : "hover:text-text"}
          >
            Files
          </Link>
          <Link
            href={link({ sha: current, view: "changes" })}
            className={view === "changes" ? "font-medium text-text" : "hover:text-text"}
          >
            Changes since the start
          </Link>
        </p>
      </div>

      {!tree.ok && <Alert tone="error">{tree.message}</Alert>}

      {tree.ok && view === "files" && (
        <div className="grid gap-6 lg:grid-cols-4">
          <Card title="Files">
            <FileTree entries={tree.data.entries} open={q.path} href={(p) => link({ sha: current, path: p })} />
            {tree.data.truncated && (
              <p className="mt-2 text-xs text-warning">GitHub listed only part of this repository.</p>
            )}
          </Card>
          <div className="lg:col-span-3">
            {!q.path ? (
              <Card title="Choose a file">
                <EmptyState title="Pick a file on the left">Click a line number to comment on that line.</EmptyState>
              </Card>
            ) : !file?.ok ? (
              <Alert tone="error">{file?.message ?? "Could not load the file."}</Alert>
            ) : (
              <Card title={file.data.path} description={`${file.data.size} bytes`}>
                {file.data.binary || file.data.tooLarge ? (
                  <EmptyState title={file.data.binary ? "Binary file" : "Too large to show"} />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full font-mono text-xs" data-testid="file-view">
                      <tbody>
                        {(file.data.content ?? "")
                          .replace(/\n$/, "")
                          .split("\n")
                          .map((text, i) => {
                            const n = i + 1;
                            const notes = here.filter((c) => c.line === n);
                            return [
                              <tr key={n} id={`L${n}`} className={line === n ? "bg-accent/10" : ""}>
                                <td className="w-12 pr-3 text-right align-top text-muted select-none">
                                  <Link
                                    href={`${link({ sha: current, path: q.path, line: String(n) })}#L${n}`}
                                    className="hover:text-accent"
                                    aria-label={`Comment on line ${n}`}
                                  >
                                    {n}
                                  </Link>
                                </td>
                                <td className="whitespace-pre">{text}</td>
                              </tr>,
                              ...notes.map((c) => (
                                <tr key={c.id}>
                                  <td />
                                  <td className="py-1">
                                    <div className="rounded-md border border-warning/40 bg-surface p-2 font-sans text-sm whitespace-normal">
                                      <p className="text-xs text-muted">
                                        {c.author?.full_name ?? c.author?.email ?? "Staff"} ·{" "}
                                        {formatInZone(c.created_at, course.timezone)}
                                      </p>
                                      <p className="whitespace-pre-wrap">{c.body}</p>
                                      {c.author_id === ctx.session.userId && (
                                        <form action={deleteReviewComment} className="mt-1">
                                          {Object.entries({ ...ids, id: c.id, sha: c.sha, path: c.path }).map(
                                            ([k, v]) => (
                                              <input key={k} type="hidden" name={k} value={v} />
                                            ),
                                          )}
                                          <Button type="submit" variant="secondary" className="px-2 py-0.5 text-xs">
                                            Delete
                                          </Button>
                                        </form>
                                      )}
                                    </div>
                                  </td>
                                </tr>
                              )),
                              ...(line === n && current
                                ? [
                                    <tr key={`form-${n}`}>
                                      <td />
                                      <td className="py-2">
                                        <CommentForm {...ids} sha={current} path={q.path!} line={n} />
                                      </td>
                                    </tr>,
                                  ]
                                : []),
                            ];
                          })}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            )}
          </div>
        </div>
      )}

      {tree.ok &&
        view === "changes" &&
        diff &&
        (!diff.ok ? (
          <Alert tone="error">{diff.message}</Alert>
        ) : (
          <div className="space-y-4" data-testid="changes">
            <p className="text-sm text-muted">
              {diff.data.files.length} files changed in {diff.data.totalCommits} commit(s) since{" "}
              <span className="font-mono">{diff.data.base.slice(0, 7)}</span>
              {diff.data.truncated && " (GitHub lists at most 300 files)"}.
            </p>
            {diff.data.files.map((f) => (
              <Card
                key={f.filename}
                title={f.previousFilename ? `${f.previousFilename} → ${f.filename}` : f.filename}
                actions={
                  <span className="flex items-center gap-2 text-sm">
                    <Badge tone={f.status === "added" ? "success" : f.status === "removed" ? "danger" : "neutral"}>
                      {f.status}
                    </Badge>
                    <span className="text-success">+{f.additions}</span>
                    <span className="text-danger">−{f.deletions}</span>
                    {f.status !== "removed" && (
                      <Link href={link({ sha: current, path: f.filename })} className="text-accent hover:underline">
                        View file
                      </Link>
                    )}
                  </span>
                }
              >
                {f.patch ? (
                  <pre className="overflow-x-auto font-mono text-xs leading-5">
                    {f.patch.split("\n").map((l, i) => (
                      <span
                        key={i}
                        className={`block ${l.startsWith("+") ? "bg-success-bg" : l.startsWith("-") ? "bg-danger-bg" : l.startsWith("@@") ? "text-muted" : ""}`}
                      >
                        {l || " "}
                      </span>
                    ))}
                  </pre>
                ) : (
                  <p className="text-sm text-muted">No text diff (binary or too large).</p>
                )}
              </Card>
            ))}
          </div>
        ))}

      {allComments.length > 0 && (
        <Card title="All comments" description="Students see them once grades are released.">
          <ul className="divide-y divide-border text-sm">
            {allComments.map((c) => (
              <li key={c.id} className="py-2">
                <Link
                  href={`${link({ sha: c.sha, path: c.path, line: String(c.line) })}#L${c.line}`}
                  className="font-mono text-xs text-accent hover:underline"
                >
                  {c.path}:{c.line} @ {c.sha.slice(0, 7)}
                </Link>
                <p className="whitespace-pre-wrap">{c.body}</p>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
