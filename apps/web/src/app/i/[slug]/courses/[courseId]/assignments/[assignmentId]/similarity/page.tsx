import { formatInZone } from "@hbe/core";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BarList, percent, TableView } from "@/components/charts";
import { Alert, Card, EmptyState } from "@/components/ui";
import type { SimilarityReport, SimilaritySide } from "@/lib/analytics";
import { apiFetch } from "@/lib/api";
import { requireMembership } from "@/lib/institution";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SimilarityCheckForm } from "../forms";

export const metadata: Metadata = { title: "Similar code" };

type Props = { params: Promise<{ slug: string; courseId: string; assignmentId: string }> };

const label = (s: SimilaritySide) =>
  s.team ? `${s.team} (${s.people.join(", ")})` : s.people.join(", ") || "Unknown student";

export default async function SimilarityPage({ params }: Props) {
  const { slug, courseId, assignmentId } = await params;
  const ctx = await requireMembership(slug);
  const supabase = await createSupabaseServerClient();
  const { data: a } = await supabase
    .from("assignments")
    .select("id, title, status, course:courses(code, name, timezone)")
    .eq("id", assignmentId)
    .eq("course_id", courseId)
    .eq("institution_id", ctx.institution.id)
    .maybeSingle();
  if (!a) notFound();
  const result = await apiFetch<SimilarityReport>(`/v1/assignments/${assignmentId}/similarity`);
  if (!result.ok) notFound(); // course staff only
  const { report, pairs } = result.data;
  const course = a.course as unknown as { code: string; name: string; timezone: string };
  const back = `/i/${slug}/courses/${courseId}/assignments/${assignmentId}`;
  const code = (side: SimilaritySide, at: { path: string; from: number }) =>
    `${back}/submissions/${side.submissionId}/code?${new URLSearchParams({
      ...(side.finalSha ? { sha: side.finalSha } : {}),
      path: at.path,
      line: String(at.from),
    })}#L${at.from}`;
  const active = report?.status === "queued" || report?.status === "running";
  const ids = { slug, courseId, assignmentId };

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm text-muted">
          <Link href={back} className="link">
            {a.title}
          </Link>{" "}
          · {course.code} {course.name}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Similar code</h1>
        <p className="mt-1 max-w-prose text-sm text-muted">
          For staff. Compares the graded commits for passages of code that match even after renaming and reformatting,
          leaving out the starter code and what most submissions share. Similar code is a reason to look, not proof
          (students may have worked from the same tutorial or answer), and nothing here changes a grade.
        </p>
      </div>

      <Card title="Check">
        <div className="space-y-3 text-sm">
          {!report && <p>No check yet. Run one once the cutoff has passed and the submissions are graded.</p>}
          {active && (
            <Alert tone="info">
              Checking since {formatInZone(report.createdAt, course.timezone)}. Refresh the page in a minute or two.
            </Alert>
          )}
          {report?.status === "failed" && (
            <Alert tone="error">The check failed{report.error ? `: ${report.error}` : "."} Try again.</Alert>
          )}
          {report?.status === "completed" && (
            <p>
              Compared {report.compared} {report.compared === 1 ? "repository" : "repositories"} on{" "}
              {formatInZone(report.finishedAt ?? report.createdAt, course.timezone)} (a team&apos;s counts once).{" "}
              {report.starterExcluded
                ? "The starter code was left out."
                : "The starter code couldn't be read from GitHub, so code everyone was given may show up below."}
            </p>
          )}
          {report && report.skipped.length > 0 && (
            <details>
              <summary className="cursor-pointer text-muted hover:text-text">
                {report.skipped.length} not compared
              </summary>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
                {report.skipped.map((s) => (
                  <li key={s.submission_id}>
                    <Link href={`${back}/submissions/${s.submission_id}`} className="link">
                      Submission
                    </Link>
                    : {s.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {!active && <SimilarityCheckForm {...ids} again={Boolean(report)} />}
        </div>
      </Card>

      {report?.status === "completed" && (
        <Card
          title="Pairs with similar code"
          description="Most similar first: the share of the smaller submission's own code that also appears in the other."
        >
          {pairs.length === 0 ? (
            <EmptyState title="No similar pairs">Nothing matched beyond the starter code and common code.</EmptyState>
          ) : (
            <>
              <BarList
                label="Similarity of each pair"
                rows={pairs.map((p) => ({
                  key: p.id,
                  name: `${label(p.a)} · ${label(p.b)}`,
                  value: p.score,
                  display: percent(p.score),
                  tip: `${label(p.a)} and ${label(p.b)}: ${percent(p.score)} similar, ${p.shared} matching fingerprints`,
                }))}
              />
              <TableView
                caption="Similarity of each pair"
                head={["Submission", "Submission", "Similar", "Matching fingerprints"]}
                rows={pairs.map((p) => [label(p.a), label(p.b), percent(p.score), p.shared])}
              />
              <ul className="mt-6 divide-y divide-border">
                {pairs.map((p) => (
                  <li key={p.id} className="py-3 text-sm" data-testid="similar-pair">
                    <details>
                      <summary className="cursor-pointer">
                        <span className="font-medium">{label(p.a)}</span> and{" "}
                        <span className="font-medium">{label(p.b)}</span>
                        <span className="text-muted">
                          {" "}
                          · {percent(p.score)} similar · {p.matches.length} matching{" "}
                          {p.matches.length === 1 ? "passage" : "passages"}
                        </span>
                      </summary>
                      <div className="mt-3 overflow-x-auto">
                        <table className="w-full text-left tabular-nums">
                          <caption className="sr-only">
                            Matching passages of {label(p.a)} and {label(p.b)}
                          </caption>
                          <thead className="text-xs text-muted">
                            <tr>
                              <th scope="col" className="py-1 pr-4 font-medium">
                                {label(p.a)}
                              </th>
                              <th scope="col" className="py-1 pr-4 font-medium">
                                {label(p.b)}
                              </th>
                              <th scope="col" className="py-1 pr-4 font-medium">
                                Fingerprints
                              </th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border">
                            {p.matches.map((m, i) => (
                              <tr key={i}>
                                <td className="py-1 pr-4">
                                  <Link href={code(p.a, m.a)} className="link break-all font-mono text-xs">
                                    {m.a.path}:{m.a.from}–{m.a.to}
                                  </Link>
                                </td>
                                <td className="py-1 pr-4">
                                  <Link href={code(p.b, m.b)} className="link break-all font-mono text-xs">
                                    {m.b.path}:{m.b.from}–{m.b.to}
                                  </Link>
                                </td>
                                <td className="py-1 pr-4 text-muted">{m.fingerprints}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </details>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>
      )}
    </div>
  );
}
