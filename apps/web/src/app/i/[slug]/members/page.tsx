import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Button, Card, EmptyState, roleTone } from "@/components/ui";
import { requireMembership } from "@/lib/institution";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { revokeInvitation } from "./actions";
import { loadMembers } from "./data";
import { CsvImportForm, InviteForm, MemberControls } from "./forms";

export const metadata: Metadata = { title: "Members" };

export default async function MembersPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { institution, isAdmin, isStaff, session, writable } = await requireMembership(slug);
  if (!isStaff) notFound();
  const supabase = await createSupabaseServerClient();
  const canManage = isAdmin && writable;

  const [members, invitations, courses] = await Promise.all([
    loadMembers(supabase, institution.id),
    isAdmin
      ? supabase
          .from("invitations")
          .select("id, email, github_login, role, course_role, expires_at, course:courses(code, term)")
          .eq("institution_id", institution.id)
          .is("accepted_at", null)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [] as never[] }),
    supabase
      .from("courses")
      .select("id, code, name, term")
      .eq("institution_id", institution.id)
      .is("archived_at", null)
      .order("code"),
  ]);
  const courseOptions = (courses.data ?? []).map((c) => ({ id: c.id, label: `${c.code} · ${c.name} (${c.term})` }));
  const pending = (invitations.data ?? []) as unknown as {
    id: string;
    email: string | null;
    github_login: string | null;
    role: string;
    course_role: string | null;
    expires_at: string;
    course: { code: string; term: string } | null;
  }[];

  return (
    <div className="space-y-6">
      {canManage && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card
            title="Invite someone"
            description="They join when they first sign in with this email or GitHub account."
          >
            <InviteForm slug={slug} courses={courseOptions} />
          </Card>
          <Card
            title="Import from CSV"
            description="Invite a whole class at once. Existing members are added to courses directly."
          >
            <CsvImportForm slug={slug} />
          </Card>
        </div>
      )}

      {isAdmin && (
        <Card title="Pending invitations" description={`${pending.length} waiting`}>
          {pending.length === 0 ? (
            <EmptyState title="No pending invitations" />
          ) : (
            <ul className="divide-y divide-border">
              {pending.map((inv) => (
                <li key={inv.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{inv.email ?? `@${inv.github_login}`}</span>
                    <Badge tone={roleTone(inv.role)}>{inv.role}</Badge>
                    {inv.course && (
                      <span className="text-muted">
                        {inv.course.code} ({inv.course.term}) · {inv.course_role}
                      </span>
                    )}
                  </span>
                  <span className="flex items-center gap-3 text-muted">
                    expires {new Date(inv.expires_at).toLocaleDateString("en-SG")}
                    {canManage && (
                      <form action={revokeInvitation}>
                        <input type="hidden" name="slug" value={slug} />
                        <input type="hidden" name="id" value={inv.id} />
                        <Button type="submit" variant="secondary" className="px-2.5 py-1">
                          Revoke
                        </Button>
                      </form>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <Card title="Members" description={`${members.filter((m) => m.status === "active").length} active`}>
        {members.length === 0 ? (
          <EmptyState title="No members yet" />
        ) : (
          <ul className="divide-y divide-border">
            {members.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    {m.role === "student" ? (
                      <Link href={`/i/${slug}/students/${m.user_id}`} className="hover:text-accent">
                        {m.profile?.full_name ?? m.profile?.email ?? "Unknown"}
                      </Link>
                    ) : (
                      (m.profile?.full_name ?? m.profile?.email ?? "Unknown")
                    )}
                    {m.user_id === session.userId && <span className="text-xs text-muted">(you)</span>}
                    {m.status !== "active" && <Badge tone="warning">deactivated</Badge>}
                  </p>
                  <p className="text-muted">
                    {m.profile?.email}
                    {m.profile?.github_login ? ` · @${m.profile.github_login}` : " · GitHub not linked"}
                  </p>
                </div>
                {canManage ? (
                  <MemberControls slug={slug} id={m.id} role={m.role} status={m.status} />
                ) : (
                  <Badge tone={roleTone(m.role)}>{m.role}</Badge>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
