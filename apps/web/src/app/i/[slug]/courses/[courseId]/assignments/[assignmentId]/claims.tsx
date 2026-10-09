import { formatInZone } from "@hbe/core";
import { Alert, Badge, Button, Card } from "@/components/ui";
import type { createSupabaseServerClient } from "@/lib/supabase/server";
import { claimCommits, reviewClaims } from "./claim-actions";

type Supabase = Awaited<ReturnType<typeof createSupabaseServerClient>>;

interface Unattributed {
  id: string;
  sha: string;
  message: string;
  authored_at: string;
  author_email: string | null;
  author_name: string | null;
  author_login: string | null;
}

interface Claim {
  id: string;
  commit_id: string;
  status: "pending" | "approved" | "rejected";
  note: string | null;
  created_at: string;
  commit: Unattributed | null;
}

const STATUS = {
  pending: { label: "waiting for your instructor", tone: "accent" },
  approved: { label: "confirmed", tone: "success" },
  rejected: { label: "declined", tone: "danger" },
} as const;

const authorOf = (c: Pick<Unattributed, "author_email" | "author_name" | "author_login">) =>
  c.author_email ?? c.author_name ?? c.author_login ?? "an unknown author";

/**
 * Commits in the student's repository that count for nobody (their git email isn't on anyone's
 * GitHub account), grouped by who git says wrote them; the student claims theirs.
 */
export async function ClaimCommitsCard({
  supabase,
  ids,
  repositoryId,
  userId,
  timezone,
  query,
}: {
  supabase: Supabase;
  ids: { slug: string; courseId: string; assignmentId: string; submissionId: string };
  repositoryId: string;
  userId: string;
  timezone: string;
  query: Record<string, string | undefined>;
}) {
  const [{ data: commitRows }, { data: claimRows }] = await Promise.all([
    supabase
      .from("commits")
      .select("id, sha, message, authored_at, author_email, author_name, author_login")
      .eq("repository_id", repositoryId)
      .is("author_profile_id", null)
      .eq("is_bot", false)
      .neq("details_status", "pending") // GitHub may still match them to an account
      .order("authored_at", { ascending: false })
      .limit(200),
    supabase
      .from("commit_claims")
      .select(
        "id, commit_id, status, note, created_at, commit:commits(id, sha, message, authored_at, author_email, author_name, author_login)",
      )
      .eq("repository_id", repositoryId)
      .eq("claimed_by", userId)
      .order("created_at", { ascending: false }),
  ]);
  const claims = (claimRows ?? []) as unknown as Claim[];
  const open = new Set(claims.filter((k) => k.status !== "rejected").map((k) => k.commit_id));
  const claimable = ((commitRows ?? []) as Unattributed[]).filter((c) => !open.has(c.id));
  if (!claimable.length && !claims.length && !query.claim_error) return null;

  const groups = new Map<string, Unattributed[]>();
  for (const c of claimable) groups.set(authorOf(c), [...(groups.get(authorOf(c)) ?? []), c]);
  const hidden = Object.entries(ids).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />);

  return (
    <section id="claims">
      <Card
        title="Commits not credited to you"
        description="Git credits a commit by the email in `git config user.email`. If it isn't verified on your GitHub account, the commit counts for nobody until you claim it and your instructor confirms."
      >
        <div className="space-y-4 text-sm">
          {query.claim_error && <Alert tone="error">{query.claim_error}</Alert>}
          {query.claimed && (
            <Alert tone="success">
              Claimed. Your instructor has been asked to confirm; the commits count once they do.
            </Alert>
          )}
          {[...groups].map(([author, list]) => (
            <form
              key={author}
              action={claimCommits}
              className="rounded-md border border-border p-3"
              data-testid="claimable"
            >
              {hidden}
              <p className="font-medium">
                {list.length} commit{list.length === 1 ? "" : "s"} by {author}
              </p>
              <ul className="mt-1 space-y-0.5 text-muted">
                {list.slice(0, 10).map((c) => (
                  <li key={c.id}>
                    <input type="hidden" name="commitId" value={c.id} />
                    <span className="font-mono">{c.sha.slice(0, 7)}</span> {c.message.split("\n")[0]} ·{" "}
                    {formatInZone(c.authored_at, timezone)}
                  </li>
                ))}
                {list.length > 10 && <li>…and {list.length - 10} more</li>}
              </ul>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <input
                  name="note"
                  maxLength={500}
                  placeholder="Optional note, e.g. “my laptop's git email”"
                  aria-label={`Note for ${author}`}
                  className="min-w-64 flex-1 rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
                />
                <Button type="submit" variant="secondary">
                  These are mine
                </Button>
              </div>
            </form>
          ))}
          {claims.length > 0 && (
            <ul className="divide-y divide-border" data-testid="my-claims">
              {claims.map((k) => (
                <li key={k.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="min-w-0">
                    <span className="font-mono">{k.commit?.sha.slice(0, 7)}</span> {k.commit?.message.split("\n")[0]}
                  </span>
                  <Badge tone={STATUS[k.status].tone}>{STATUS[k.status].label}</Badge>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted">
            To credit future commits directly, add that email to your GitHub account (Settings → Emails) or change it
            with <code>git config user.email</code>.
          </p>
        </div>
      </Card>
    </section>
  );
}

/** Staff: a student's pending claims on their submission, to confirm or decline. */
export async function ReviewClaimsCard({
  supabase,
  ids,
  repositoryId,
  userId,
  timezone,
  query,
}: {
  supabase: Supabase;
  ids: { slug: string; courseId: string; assignmentId: string; submissionId: string };
  repositoryId: string;
  userId: string;
  timezone: string;
  query: Record<string, string | undefined>;
}) {
  const { data } = await supabase
    .from("commit_claims")
    .select(
      "id, commit_id, status, note, created_at, commit:commits(id, sha, message, authored_at, author_email, author_name, author_login)",
    )
    .eq("repository_id", repositoryId)
    .eq("claimed_by", userId)
    .order("created_at", { ascending: false });
  const claims = (data ?? []) as unknown as Claim[];
  if (!claims.length) return null;
  const pending = claims.filter((k) => k.status === "pending");
  const emails = [...new Set(pending.map((k) => k.commit?.author_email).filter(Boolean))];
  const hidden = Object.entries(ids).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />);
  return (
    <section id="claims">
      <Card
        title="Commit claims"
        description="Commits the student says are theirs, though their git email isn't on their GitHub account."
      >
        <div className="space-y-3 text-sm">
          {query.claim_error && <Alert tone="error">{query.claim_error}</Alert>}
          {query.claims && <Alert tone="success">Claims {query.claims}.</Alert>}
          <ul className="divide-y divide-border" data-testid="claims">
            {claims.map((k) => (
              <li key={k.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
                <span className="min-w-0">
                  <span className="font-mono">{k.commit?.sha.slice(0, 7)}</span> {k.commit?.message.split("\n")[0]}
                  <span className="block text-xs text-muted">
                    by {k.commit ? authorOf(k.commit) : "?"} · claimed {formatInZone(k.created_at, timezone)}
                    {k.note && ` · “${k.note}”`}
                  </span>
                </span>
                <Badge tone={k.status === "pending" ? "warning" : STATUS[k.status].tone}>
                  {k.status === "pending" ? "to review" : STATUS[k.status].label}
                </Badge>
              </li>
            ))}
          </ul>
          {pending.length > 0 && (
            <form action={reviewClaims} className="space-y-2 border-t border-border pt-3">
              {hidden}
              {pending.map((k) => (
                <input key={k.id} type="hidden" name="claimId" value={k.id} />
              ))}
              {emails.length > 0 && (
                <label className="flex items-center gap-2">
                  <input type="checkbox" name="rememberEmail" defaultChecked />
                  Also credit their later commits from {emails.join(", ")}
                </label>
              )}
              <div className="flex gap-2">
                <Button type="submit" name="decision" value="approve">
                  Confirm {pending.length} claim{pending.length === 1 ? "" : "s"}
                </Button>
                <Button type="submit" name="decision" value="reject" variant="secondary">
                  Decline
                </Button>
              </div>
            </form>
          )}
        </div>
      </Card>
    </section>
  );
}
