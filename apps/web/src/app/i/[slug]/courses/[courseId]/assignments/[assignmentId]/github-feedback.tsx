import { formatInZone } from "@hbe/core";
import { Alert, Button, Card } from "@/components/ui";
import { postGithubFeedback } from "./github-feedback-actions";

const RESULT: Record<string, { tone: "success" | "info" | "error"; text: string }> = {
  posted: { tone: "success", text: "Posted to GitHub." },
  unchanged: { tone: "info", text: "GitHub already shows this feedback." },
  nothing: { tone: "info", text: "There's no written feedback or code comment to post yet." },
  failed: { tone: "error", text: "GitHub refused it (see below)." },
};

/** Staff: the submission's "Feedback" issue on GitHub (assignments that post feedback there). */
export function GithubFeedbackCard({
  ids,
  repo,
  released,
  timezone,
  query,
}: {
  ids: { slug: string; courseId: string; assignmentId: string; submissionId: string };
  repo: {
    owner: string;
    name: string;
    feedback_issue_number: number | null;
    feedback_posted_at: string | null;
    feedback_error: string | null;
  };
  released: boolean;
  timezone: string;
  query: Record<string, string | undefined>;
}) {
  const issueUrl = repo.feedback_issue_number
    ? `https://github.com/${repo.owner}/${repo.name}/issues/${repo.feedback_issue_number}`
    : null;
  const result = query.github ? RESULT[query.github] : undefined;
  return (
    <section id="github-feedback">
      <Card
        title="Feedback on GitHub"
        description="The written feedback and code comments, as an issue in the repository (never the scores). Updated within minutes of a change."
      >
        <div className="space-y-3 text-sm">
          {query.github_error && <Alert tone="error">{query.github_error}</Alert>}
          {result && <Alert tone={result.tone}>{result.text}</Alert>}
          {!released ? (
            <p className="text-muted">Posted once the grade is released.</p>
          ) : issueUrl ? (
            <p>
              <a href={issueUrl} className="link" data-testid="feedback-issue">
                {repo.owner}/{repo.name}#{repo.feedback_issue_number}
              </a>
              {repo.feedback_posted_at && (
                <span className="text-muted"> · checked {formatInZone(repo.feedback_posted_at, timezone)}</span>
              )}
            </p>
          ) : (
            <p className="text-muted">Not posted yet.</p>
          )}
          {repo.feedback_error && <Alert tone="error">{repo.feedback_error}</Alert>}
          {released && (
            <form action={postGithubFeedback}>
              {Object.entries(ids).map(([k, v]) => (
                <input key={k} type="hidden" name={k} value={v} />
              ))}
              <Button type="submit" variant="secondary">
                Post to GitHub now
              </Button>
            </form>
          )}
        </div>
      </Card>
    </section>
  );
}
