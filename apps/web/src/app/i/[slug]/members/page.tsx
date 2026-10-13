import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Button, Card, EmptyState, roleTone } from "@/components/ui";
import { requireMembership } from "@/lib/institution";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { revokeInvitation } from "./actions";
import { loadMembers } from "./data";
import { DecideErasureForm, EraseMemberForm } from "./erasure";
import { CsvImportForm, InviteForm, MemberControls } from "./forms";

interface ErasureRow {
  id: string;
  subject_id: string | null;
  subject_role: string;
  requested_via: "admin" | "self";
  note: string | null;
  status: "requested" | "approved" | "running" | "completed" | "rejected" | "failed";
  mode: "anonymise" | "delete" | null;
  pseudonym_id: string | null;
  pseudonym: string | null;
  decision_note: string | null;
  certificate: {
    account_deleted?: boolean;
    files?: { reports_rewritten: number; objects_deleted: number; replicas_locked: number };
  } | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
}

export const metadata: Metadata = { title: "Members" };

export default async function MembersPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { institution, isAdmin, isStaff, session, writable } = await requireMembership(slug);
  if (!isStaff) notFound();
  const supabase = await createSupabaseServerClient();
  const canManage = isAdmin && writable;

  const [members, invitations, courses, erasures] = await Promise.all([
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
    isAdmin
      ? supabase
          .from("erasure_requests")
          .select(
            "id, subject_id, subject_role, requested_via, note, status, mode, pseudonym_id, pseudonym, decision_note, certificate, error, created_at, completed_at",
          )
          .eq("institution_id", institution.id)
          .order("created_at", { ascending: false })
          .limit(50)
      : Promise.resolve({ data: [] as never[] }),
  ]);
  const requests = (erasures.data ?? []) as unknown as ErasureRow[];
  const nameOf = (userId: string | null) => {
    const m = members.find((x) => x.user_id === userId);
    return m?.profile?.full_name ?? m?.profile?.email ?? "A former member";
  };
  const day = (iso: string) => new Date(iso).toLocaleDateString("en-SG");
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
                    {m.profile?.anonymised_at ? (
                      <Badge tone="neutral">personal data erased</Badge>
                    ) : (
                      m.status !== "active" && <Badge tone="warning">deactivated</Badge>
                    )}
                  </p>
                  <p className="text-muted">
                    {m.profile?.email}
                    {m.profile?.github_login ? ` · @${m.profile.github_login}` : " · GitHub not linked"}
                  </p>
                </div>
                {canManage && !m.profile?.anonymised_at ? (
                  <MemberControls
                    slug={slug}
                    id={m.id}
                    userId={m.user_id}
                    role={m.role}
                    status={m.status}
                    self={m.user_id === session.userId}
                  />
                ) : (
                  <Badge tone={roleTone(m.role)}>{m.role}</Badge>
                )}
                {isAdmin && m.user_id !== session.userId && !m.profile?.anonymised_at && (
                  <EraseMemberForm
                    slug={slug}
                    userId={m.user_id}
                    name={m.profile?.full_name ?? m.profile?.email ?? "this member"}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {isAdmin && (
        <div id="erasure">
          <Card
            title="Erasure requests"
            description="Requests to erase a person's personal data here (PDPA). You decide how; the person can't."
          >
            {requests.length === 0 ? (
              <EmptyState title="No requests" />
            ) : (
              <ul className="divide-y divide-border" data-testid="erasure-requests">
                {requests.map((r) => (
                  <li key={r.id} className="space-y-1 py-3 text-sm">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{r.pseudonym ?? nameOf(r.subject_id)}</span>
                      <Badge tone={roleTone(r.subject_role)}>{r.subject_role}</Badge>
                      <Badge
                        tone={
                          r.status === "completed"
                            ? "success"
                            : r.status === "failed"
                              ? "danger"
                              : r.status === "rejected"
                                ? "neutral"
                                : "warning"
                        }
                      >
                        {r.status === "requested"
                          ? "waiting for a decision"
                          : r.status === "approved" || r.status === "running"
                            ? "erasing"
                            : r.status === "completed"
                              ? r.mode === "delete"
                                ? "deleted"
                                : "anonymised"
                              : r.status === "rejected"
                                ? "declined"
                                : "failed"}
                      </Badge>
                      <span className="text-muted">
                        {r.requested_via === "self" ? "asked by them" : "started by an admin"} on {day(r.created_at)}
                        {r.completed_at && ` · done ${day(r.completed_at)}`}
                      </span>
                    </p>
                    {r.note && <p className="text-muted">“{r.note}”</p>}
                    {r.status === "rejected" && r.decision_note && (
                      <p className="text-muted">Declined: {r.decision_note}</p>
                    )}
                    {r.status === "completed" && r.certificate && (
                      <p className="text-muted">
                        {r.certificate.account_deleted
                          ? "Their account was deleted."
                          : "Their account stays (they belong to another institution)."}{" "}
                        {r.certificate.files?.reports_rewritten
                          ? `${r.certificate.files.reports_rewritten} grade report(s) re-issued under the pseudonym. `
                          : ""}
                        {r.certificate.files?.objects_deleted
                          ? `${r.certificate.files.objects_deleted} file(s) deleted. `
                          : ""}
                        {r.certificate.files?.replicas_locked
                          ? `${r.certificate.files.replicas_locked} archive copies are under a compliance lock and are deleted when it ends.`
                          : ""}
                      </p>
                    )}
                    {r.status === "failed" && <p className="text-danger">{r.error}</p>}
                    {canManage && r.status === "requested" && r.subject_id !== session.userId && (
                      <DecideErasureForm slug={slug} requestId={r.id} />
                    )}
                    {canManage &&
                      r.status === "failed" &&
                      (r.pseudonym_id && r.mode ? (
                        <DecideErasureForm slug={slug} requestId={r.id} retryAs={r.mode} />
                      ) : (
                        <DecideErasureForm slug={slug} requestId={r.id} />
                      ))}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
