import { formatInZone } from "@hbe/core";
import { AutoRefresh } from "@/components/auto-refresh";
import { fmt } from "@/components/grade";
import { Alert, Badge, Button, Card } from "@/components/ui";
import type { createSupabaseServerClient } from "@/lib/supabase/server";
import { sendGradesToLms } from "./lms-actions";

type Supabase = Awaited<ReturnType<typeof createSupabaseServerClient>>;

interface Gradebook {
  id: string;
  context_title: string | null;
  context_id: string;
  connection: { name: string } | null;
}

interface SyncRow {
  grade_id: string;
  submission_id: string;
  lms_assignment_link_id: string;
  status: "pending" | "synced" | "failed" | "skipped" | "conflict";
  score_given: string | null;
  lms_score: string | null;
  last_error: string | null;
  synced_at: string | null;
  attempts: number;
}

const TONE = {
  synced: "success",
  pending: "accent",
  failed: "danger",
  skipped: "warning",
  conflict: "warning",
} as const;
const LABEL = {
  synced: "sent",
  pending: "sending",
  failed: "failed",
  skipped: "not sent",
  conflict: "changed in the LMS",
} as const;

/**
 * Staff view of an assignment's grades in the linked LMS gradebooks (AGS): what was sent, what
 * failed and why, and grades someone changed in the LMS since. Nothing shows without a link.
 */
export async function LmsGradesCard({
  supabase,
  slug,
  courseId,
  assignmentId,
  canManage,
  timezone,
  students,
  query,
}: {
  supabase: Supabase;
  slug: string;
  courseId: string;
  assignmentId: string;
  canManage: boolean;
  timezone: string;
  /** Submissions with a released current grade. */
  students: { submissionId: string; name: string; gradeId: string; finalScore: string | number }[];
  query: Record<string, string | undefined>;
}) {
  const { data: bookRows } = await supabase
    .from("lms_course_links")
    .select("id, context_title, context_id, connection:lms_connections(name)")
    .eq("course_id", courseId)
    .not("ags_lineitems_url", "is", null);
  const books = (bookRows ?? []) as unknown as Gradebook[];
  if (!books.length) return null;

  const { data: columnRows } = await supabase
    .from("lms_assignment_links")
    .select("id, lms_course_link_id, lineitem_url")
    .eq("assignment_id", assignmentId);
  const columns = (columnRows ?? []) as { id: string; lms_course_link_id: string; lineitem_url: string | null }[];
  const { data: syncRows } = columns.length
    ? await supabase
        .from("lms_grade_syncs")
        .select(
          "grade_id, submission_id, lms_assignment_link_id, status, score_given, lms_score, last_error, synced_at, attempts",
        )
        .in(
          "lms_assignment_link_id",
          columns.map((c) => c.id),
        )
    : { data: [] };
  const syncs = (syncRows ?? []) as SyncRow[];
  const columnOf = (bookId: string) => columns.find((c) => c.lms_course_link_id === bookId);
  const syncOf = (gradeId: string, bookId: string) => {
    const column = columnOf(bookId);
    return column ? syncs.find((y) => y.grade_id === gradeId && y.lms_assignment_link_id === column.id) : undefined;
  };
  const rows = students.flatMap((st) => books.map((b) => ({ st, book: b, sync: syncOf(st.gradeId, b.id) })));
  const counts = rows.reduce(
    (acc, r) => ({ ...acc, [r.sync?.status ?? "none"]: (acc[r.sync?.status ?? "none"] ?? 0) + 1 }),
    {} as Record<string, number>,
  );
  // After "Send again": refresh until every grade has an answer from the LMS (for a minute at most).
  const askedAt = Number(query.lms_at) || 0;
  const sending =
    Date.now() - askedAt < 60_000 &&
    rows.some((r) => !r.sync || r.sync.status === "pending" || Date.parse(r.sync.synced_at ?? "0") < askedAt);
  const bookName = (b: Gradebook) => `${b.context_title ?? b.context_id} (${b.connection?.name ?? "LMS"})`;
  const ids = (
    <>
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="courseId" value={courseId} />
      <input type="hidden" name="assignmentId" value={assignmentId} />
    </>
  );

  return (
    <section id="lms">
      <Card
        title="LMS gradebook"
        description={`Released grades are sent to ${books.map(bookName).join(" and ")} automatically.`}
        actions={
          canManage &&
          students.length > 0 && (
            <form action={sendGradesToLms}>
              {ids}
              <Button type="submit" variant="secondary">
                Send all grades again
              </Button>
            </form>
          )
        }
      >
        <AutoRefresh active={sending} intervalMs={5000} />
        {query.lms_error && <Alert tone="error">{query.lms_error}</Alert>}
        {query.lms_sent && sending && (
          <Alert tone="success">
            Sending {query.lms_sent} grade{query.lms_sent === "1" ? "" : "s"} to the LMS. This page updates as they go.
          </Alert>
        )}
        {students.length === 0 ? (
          <p className="text-sm text-muted">No grades are released yet. They are sent when you release them.</p>
        ) : (
          <>
            <p className="mb-3 text-sm text-muted" data-testid="lms-sync-summary">
              {counts.synced ?? 0} sent
              {counts.failed ? ` · ${counts.failed} failed` : ""}
              {counts.skipped ? ` · ${counts.skipped} not sent` : ""}
              {counts.conflict ? ` · ${counts.conflict} changed in the LMS` : ""}
              {counts.none ? ` · ${counts.none} not sent yet` : ""}
            </p>
            <ul className="divide-y divide-border text-sm" data-testid="lms-sync">
              {rows.map(({ st, book, sync }) => (
                <li
                  key={`${st.submissionId}-${book.id}`}
                  className="flex flex-wrap items-center justify-between gap-2 py-2.5"
                >
                  <span className="min-w-0">
                    {st.name}
                    {books.length > 1 && <span className="text-muted"> · {bookName(book)}</span>}
                    {sync?.status === "conflict" && (
                      <span className="block text-xs text-warning">
                        The LMS shows {fmt(sync.lms_score)}; the platform sent {fmt(sync.score_given)}. Change the grade
                        here, or send it again to overwrite the LMS.
                      </span>
                    )}
                    {(sync?.status === "failed" || sync?.status === "skipped") && sync.last_error && (
                      <span className="block max-w-xl text-xs text-muted">{sync.last_error}</span>
                    )}
                  </span>
                  <span className="flex items-center gap-3">
                    <span className="tabular-nums text-muted">{fmt(st.finalScore)}</span>
                    {sync?.status === "synced" && sync.synced_at && (
                      <span className="text-xs text-muted">{formatInZone(sync.synced_at, timezone)}</span>
                    )}
                    <Badge tone={sync ? TONE[sync.status] : "neutral"}>
                      {sync ? LABEL[sync.status] : "not sent yet"}
                    </Badge>
                    {canManage && sync && sync.status !== "synced" && sync.status !== "pending" && (
                      <form action={sendGradesToLms}>
                        {ids}
                        <input type="hidden" name="submissionId" value={st.submissionId} />
                        <Button type="submit" variant="secondary" className="px-2 py-0.5 text-xs">
                          Send again
                        </Button>
                      </form>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
    </section>
  );
}
