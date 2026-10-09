import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Alert, Button, Card } from "@/components/ui";
import { requireMembership } from "@/lib/institution";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { linkLmsCourse } from "./actions";

export const metadata: Metadata = { title: "Link your LMS course" };

/**
 * Where an instructor lands after launching from an LMS course nobody has linked yet: they
 * choose which of their courses it is, and learners launching from it then join that course.
 */
export default async function LinkCoursePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; linkId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { slug, linkId } = await params;
  const query = await searchParams;
  const ctx = await requireMembership(slug);
  const supabase = await createSupabaseServerClient();
  const { data: link } = await supabase
    .from("lms_course_links")
    .select("id, context_title, context_id, course_id, connection:lms_connections(name)")
    .eq("id", linkId)
    .maybeSingle();

  if (link?.course_id) redirect(`/i/${slug}/courses/${link.course_id}`);
  if (!link || !ctx.isStaff) {
    return (
      <Alert tone="info">
        This LMS course isn&apos;t linked to a course you teach here. Ask your institution&apos;s admin to link it.
      </Alert>
    );
  }

  // The courses this person may link: theirs as instructor, or any for admins.
  const { data: courseRows } = ctx.isAdmin
    ? await supabase
        .from("courses")
        .select("id, code, name, term")
        .eq("institution_id", ctx.institution.id)
        .is("archived_at", null)
        .order("code")
    : await supabase
        .from("courses")
        .select("id, code, name, term, course_memberships!inner(user_id, role)")
        .eq("institution_id", ctx.institution.id)
        .is("archived_at", null)
        .eq("course_memberships.user_id", ctx.session.userId)
        .eq("course_memberships.role", "instructor")
        .order("code");
  const courses = (courseRows ?? []) as { id: string; code: string; name: string; term: string | null }[];
  const title = link.context_title ?? link.context_id;
  const connection = (link.connection as unknown as { name: string } | null)?.name ?? "your LMS";

  return (
    <div className="max-w-2xl space-y-4">
      {query.error && <Alert tone="error">{query.error}</Alert>}
      <Card
        title={`Link “${title}”`}
        description={`You opened HBE Projects from a course in ${connection} that isn't linked to a course here yet.`}
      >
        {courses.length === 0 ? (
          <p className="text-sm">
            You aren&apos;t an instructor of any course here yet. Ask your institution&apos;s admin to create the course
            and add you as its instructor, then open the activity in your LMS again.
          </p>
        ) : (
          <form action={linkLmsCourse} className="space-y-3">
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="linkId" value={link.id} />
            <fieldset className="space-y-2">
              <legend className="mb-1 text-sm font-medium">Which course is it?</legend>
              {courses.map((c, i) => (
                <label key={c.id} className="flex items-center gap-2 text-sm">
                  <input type="radio" name="courseId" value={c.id} defaultChecked={i === 0} />
                  <span>
                    {c.code} {c.name}
                    {c.term && <span className="text-muted"> · {c.term}</span>}
                  </span>
                </label>
              ))}
            </fieldset>
            <p className="text-sm text-muted">
              Students who open the activity from this LMS course will join the course you choose.
            </p>
            <Button type="submit">Link course</Button>
          </form>
        )}
      </Card>
    </div>
  );
}
