import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Card, EmptyState } from "@/components/ui";
import { requireMembership } from "@/lib/institution";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { CreateCourseForm } from "./forms";

export const metadata: Metadata = { title: "Courses" };

export default async function CoursesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { institution, isStaff, writable } = await requireMembership(slug);
  const supabase = await createSupabaseServerClient();

  const [courses, installations] = await Promise.all([
    supabase
      .from("courses")
      .select("id, code, name, term, archived_at, github:github_installations(account_login)")
      .eq("institution_id", institution.id)
      .order("archived_at", { nullsFirst: true })
      .order("term", { ascending: false })
      .order("code"),
    isStaff
      ? supabase
          .from("github_installations")
          .select("id, account_login")
          .eq("institution_id", institution.id)
          .is("deleted_at", null)
      : Promise.resolve({ data: [] as never[] }),
  ]);
  const rows = (courses.data ?? []) as unknown as {
    id: string;
    code: string;
    name: string;
    term: string;
    archived_at: string | null;
    github: { account_login: string } | null;
  }[];

  return (
    <div className="space-y-6">
      {isStaff && writable && (
        <Card title="New course" description="You become its instructor.">
          <CreateCourseForm
            slug={slug}
            installations={(installations.data ?? []).map((i) => ({ id: i.id, login: i.account_login }))}
          />
        </Card>
      )}
      <Card title="Courses">
        {rows.length === 0 ? (
          <EmptyState title="No courses yet" />
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                <Link href={`/i/${slug}/courses/${c.id}`} className="hover:text-accent">
                  <span className="font-medium">{c.code}</span> · {c.name}
                </Link>
                <span className="flex items-center gap-2 text-muted">
                  {c.github ? c.github.account_login : isStaff ? "no GitHub org" : null}
                  <span>{c.term}</span>
                  {c.archived_at && <Badge>archived</Badge>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
