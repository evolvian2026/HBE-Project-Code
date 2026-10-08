/**
 * The process score: a 0–100 grade component built from repository activity.
 * Designed to be fair and hard to game (ARCHITECTURE §5.4): only meaningful commits by
 * the student before the deadline count, daily credit is capped, and every point lost
 * comes with an explanation the student can act on.
 */

export interface ProcessPolicy {
  criteria: ProcessCriterion[];
  meaningful_commit_min_lines: number;
  max_commits_per_day: number;
}

export type ProcessCriterion =
  | { key: "active_days"; target: number; weight: number }
  | { key: "steady_progress"; threshold: number; weight: number }
  | { key: "pr_workflow"; target: number; weight: number }
  | { key: "issue_tracking"; target: number; weight: number };

export interface CommitFacts {
  sha: string;
  authoredAt: Date;
  /** Attributed to the student by GitHub user id. */
  byStudent: boolean;
  isBot: boolean;
  parentCount: number | null;
  /** Changed lines outside ignored paths, excluding whitespace-only lines. Null while details are pending. */
  effectiveLines: number | null;
}

export type CommitVerdict =
  | { meaningful: true }
  | { meaningful: false; reason: "pending" | "not_student" | "bot" | "merge" | "after_deadline" | "too_small" };

export function classifyCommit(
  c: CommitFacts,
  policy: Pick<ProcessPolicy, "meaningful_commit_min_lines">,
  deadline: Date,
): CommitVerdict {
  if (c.effectiveLines === null) return { meaningful: false, reason: "pending" };
  if (c.isBot) return { meaningful: false, reason: "bot" };
  if (!c.byStudent) return { meaningful: false, reason: "not_student" };
  if ((c.parentCount ?? 1) > 1) return { meaningful: false, reason: "merge" };
  if (c.authoredAt > deadline) return { meaningful: false, reason: "after_deadline" };
  if (c.effectiveLines < policy.meaningful_commit_min_lines) return { meaningful: false, reason: "too_small" };
  return { meaningful: true };
}

export interface PullRequestFacts {
  byStudent: boolean;
  bodyLength: number;
  linkedIssues: number[];
  mergedAt: Date | null;
}

export interface IssueFacts {
  byStudent: boolean;
  closedAt: Date | null;
}

export interface CriterionResult {
  key: ProcessCriterion["key"];
  label: string;
  weight: number;
  /** 0..1 */
  earned: number;
  points: number;
  explanation: string;
}

export interface ProcessResult {
  score: number;
  criteria: CriterionResult[];
  meaningfulCommits: number;
  creditedCommits: number;
  unattributedCommits: number;
  pendingCommits: number;
}

const round = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places;
const pct = (n: number) => `${Math.round(n * 100)}%`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Local calendar date of an instant in the course's time zone. */
function localDate(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export function computeProcessScore(input: {
  policy: ProcessPolicy;
  commits: CommitFacts[];
  pullRequests: PullRequestFacts[];
  issues: IssueFacts[];
  deadline: Date;
  timeZone: string;
}): ProcessResult {
  const { policy, deadline, timeZone } = input;
  const verdicts = input.commits.map((c) => ({ c, v: classifyCommit(c, policy, deadline) }));
  const meaningful = verdicts.filter((x) => x.v.meaningful).map((x) => x.c);

  // Daily cap: at most max_commits_per_day commits (and their lines) count per day.
  const byDay = new Map<string, CommitFacts[]>();
  for (const c of meaningful.sort((a, b) => a.authoredAt.getTime() - b.authoredAt.getTime())) {
    const day = localDate(c.authoredAt, timeZone);
    const list = byDay.get(day) ?? [];
    if (list.length < policy.max_commits_per_day) list.push(c);
    byDay.set(day, list);
  }
  const credited = [...byDay.values()].flat();

  const results: CriterionResult[] = policy.criteria.map((criterion) => {
    switch (criterion.key) {
      case "active_days": {
        const days = byDay.size;
        const earned = Math.min(1, days / criterion.target);
        return {
          key: criterion.key,
          label: "Steady work across days",
          weight: criterion.weight,
          earned,
          points: 0,
          explanation:
            earned >= 1
              ? `Active on ${plural(days, "day")} (target ${criterion.target}).`
              : `Active on ${days} of ${criterion.target} target days. Commit meaningful work on more separate days.`,
        };
      }
      case "steady_progress": {
        const total = credited.reduce((s, c) => s + (c.effectiveLines ?? 0), 0);
        const lastDayStart = deadline.getTime() - 24 * 3600_000;
        const late = credited
          .filter((c) => c.authoredAt.getTime() > lastDayStart)
          .reduce((s, c) => s + (c.effectiveLines ?? 0), 0);
        const share = total === 0 ? 1 : late / total;
        const t = criterion.threshold;
        const earned = total === 0 ? 0 : share <= t ? 1 : Math.max(0, 1 - (share - t) / (1 - t));
        return {
          key: criterion.key,
          label: "Not leaving it to the last day",
          weight: criterion.weight,
          earned,
          points: 0,
          explanation:
            total === 0
              ? "No meaningful work committed yet."
              : earned >= 1
                ? `${pct(share)} of your work came in the final 24 hours (limit ${pct(t)}).`
                : `${pct(share)} of your work came in the final 24 hours; aim for at most ${pct(t)}.`,
        };
      }
      case "pr_workflow": {
        const good = input.pullRequests.filter(
          (p) => p.byStudent && p.mergedAt && p.mergedAt <= deadline && p.bodyLength >= 20 && p.linkedIssues.length > 0,
        ).length;
        const merged = input.pullRequests.filter((p) => p.byStudent && p.mergedAt).length;
        const earned = Math.min(1, good / criterion.target);
        return {
          key: criterion.key,
          label: "Pull request workflow",
          weight: criterion.weight,
          earned,
          points: 0,
          explanation:
            earned >= 1
              ? `${plural(good, "merged pull request")} with a description and a linked issue (target ${criterion.target}).`
              : `${good} of ${criterion.target} merged pull requests have a description and link an issue (“Closes #12”)` +
                (merged > good ? `; ${merged - good} merged without one.` : "."),
        };
      }
      case "issue_tracking": {
        const closed = input.issues.filter((i) => i.byStudent && i.closedAt && i.closedAt <= deadline).length;
        const earned = Math.min(1, closed / criterion.target);
        return {
          key: criterion.key,
          label: "Issue tracking",
          weight: criterion.weight,
          earned,
          points: 0,
          explanation:
            earned >= 1
              ? `${plural(closed, "issue")} opened and closed (target ${criterion.target}).`
              : `${closed} of ${criterion.target} issues opened and closed. Track your tasks as GitHub issues.`,
        };
      }
    }
  });

  const totalWeight = results.reduce((s, r) => s + r.weight, 0) || 1;
  for (const r of results) r.points = round((r.weight / totalWeight) * r.earned * 100);
  return {
    score: round(results.reduce((s, r) => s + r.points, 0)),
    criteria: results,
    meaningfulCommits: meaningful.length,
    creditedCommits: credited.length,
    unattributedCommits: verdicts.filter((x) => !x.v.meaningful && x.v.reason === "not_student" && !x.c.isBot).length,
    pendingCommits: verdicts.filter((x) => !x.v.meaningful && x.v.reason === "pending").length,
  };
}

// ---------------------------------------------------------------------------
// Effective changed lines
// ---------------------------------------------------------------------------

/** Converts a path glob (`**`, `*`, `?`) into an anchored RegExp. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

export interface FileChange {
  filename: string;
  additions: number;
  deletions: number;
  /** Unified diff; absent for binary or very large files. */
  patch?: string;
}

/**
 * Lines that count toward a commit's size: files outside `ignorePaths`, and (when the
 * patch is available) changed lines that are not blank or whitespace-only.
 */
export function effectiveLines(files: FileChange[], ignorePaths: string[]): number {
  const ignored = ignorePaths.map(globToRegExp);
  let total = 0;
  for (const f of files) {
    if (ignored.some((re) => re.test(f.filename))) continue;
    if (f.patch === undefined) {
      total += f.additions + f.deletions;
      continue;
    }
    for (const line of f.patch.split("\n")) {
      if ((line.startsWith("+") && !line.startsWith("+++")) || (line.startsWith("-") && !line.startsWith("---"))) {
        if (line.slice(1).trim() !== "") total++;
      }
    }
  }
  return total;
}

/** Issue numbers a PR closes, from GitHub's closing keywords in its body. */
export function linkedIssues(body: string | null | undefined): number[] {
  const found = new Set<number>();
  for (const m of (body ?? "").matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)\b/gi))
    found.add(Number(m[1]));
  return [...found].sort((a, b) => a - b);
}
