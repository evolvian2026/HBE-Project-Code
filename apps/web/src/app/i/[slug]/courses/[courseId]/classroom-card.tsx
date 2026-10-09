import { Alert, Badge, Button, Card } from "@/components/ui";
import { apiFetch } from "@/lib/api";
import type { createSupabaseServerClient } from "@/lib/supabase/server";
import { connectGoogle, disconnectGoogle, linkClassroomClass } from "./lms-actions";

type Supabase = Awaited<ReturnType<typeof createSupabaseServerClient>>;

interface ClassroomClass {
  id: string;
  name: string;
  section: string | null;
  linkedCourseId: string | null;
}

const selectClass = "rounded-md border border-border bg-surface px-2 py-1.5 text-sm";

/**
 * Google Classroom on a course page (staff): the teacher's Google connection, the classes
 * linked to this course, and linking another of their classes. Shown once an admin turns
 * Google Classroom on.
 */
export async function ClassroomCard({
  supabase,
  slug,
  courseId,
  institutionId,
  userId,
  canManage,
  query,
}: {
  supabase: Supabase;
  slug: string;
  courseId: string;
  institutionId: string;
  userId: string;
  canManage: boolean;
  query: Record<string, string | undefined>;
}) {
  const { data: conn } = await supabase
    .from("lms_connections")
    .select("id")
    .eq("institution_id", institutionId)
    .eq("type", "google_classroom")
    .eq("status", "active")
    .maybeSingle();
  if (!conn) return null;
  const [{ data: account }, { data: linkRows }] = await Promise.all([
    supabase
      .from("google_accounts")
      .select("id, email, revoked_at, last_error")
      .eq("institution_id", institutionId)
      .eq("profile_id", userId)
      .maybeSingle(),
    supabase
      .from("lms_course_links")
      .select("id, context_id, context_title")
      .eq("course_id", courseId)
      .eq("lms_connection_id", conn.id),
  ]);
  const linked = (linkRows ?? []) as { id: string; context_id: string; context_title: string | null }[];
  const connected = account && !account.revoked_at;
  const classes =
    canManage && connected
      ? await apiFetch<{ classes: ClassroomClass[] }>(`/v1/courses/${courseId}/classroom-classes`)
      : null;
  const linkable = classes?.ok ? classes.data.classes.filter((c) => !c.linkedCourseId) : [];
  const ids = (
    <>
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="courseId" value={courseId} />
      <input type="hidden" name="institutionId" value={institutionId} />
    </>
  );

  return (
    <section id="classroom">
      <Card
        title="Google Classroom"
        description="Students in a linked class join this course; post assignments there and their released grades follow."
      >
        <div className="space-y-4 text-sm">
          {query.google === "connected" && <Alert tone="success">Your Google account is connected.</Alert>}
          {query.google_error && <Alert tone="error">{query.google_error}</Alert>}
          {linked.length > 0 ? (
            <ul className="divide-y divide-border" data-testid="classroom-classes">
              {linked.map((l) => (
                <li key={l.id} className="py-2">
                  {l.context_title ?? l.context_id}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted">No Classroom class is linked to this course yet.</p>
          )}
          {canManage &&
            (connected ? (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2 text-muted">
                  Connected as <span className="text-text">{account.email}</span>
                  <form action={disconnectGoogle} className="inline">
                    {ids}
                    <button type="submit" className="text-accent hover:underline">
                      Disconnect
                    </button>
                  </form>
                </div>
                {classes && !classes.ok && <Alert tone="error">{classes.message}</Alert>}
                {linkable.length > 0 && (
                  <form action={linkClassroomClass} className="flex flex-wrap items-center gap-2">
                    {ids}
                    <select name="classId" defaultValue="" className={selectClass} aria-label="Classroom class">
                      <option value="">Choose one of your classes…</option>
                      {linkable.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.section ? `${c.name} (${c.section})` : c.name}
                        </option>
                      ))}
                    </select>
                    <Button type="submit" variant="secondary">
                      Link class
                    </Button>
                  </form>
                )}
              </div>
            ) : (
              <form action={connectGoogle} className="flex flex-wrap items-center gap-3">
                {ids}
                {account?.revoked_at && <Badge tone="warning">Google access expired</Badge>}
                <Button type="submit">Connect Google Classroom</Button>
              </form>
            ))}
        </div>
      </Card>
    </section>
  );
}
