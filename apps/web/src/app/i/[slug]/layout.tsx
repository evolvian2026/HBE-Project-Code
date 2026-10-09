import type { ReactNode } from "react";
import { AppShell, PageTitle } from "@/components/app-shell";
import { InstitutionNav } from "@/components/institution-nav";
import { Badge, roleTone } from "@/components/ui";
import { requireMembership } from "@/lib/institution";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export default async function InstitutionLayout({
  params,
  children,
}: {
  params: Promise<{ slug: string }>;
  children: ReactNode;
}) {
  const { slug } = await params;
  const ctx = await requireMembership(slug);
  const supabase = await createSupabaseServerClient();
  const { count: unread } = await supabase
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("institution_id", ctx.institution.id)
    .is("read_at", null);
  const tabs = [
    { href: "", label: "Overview" },
    { href: "/courses", label: ctx.role === "student" ? "My courses" : "Courses" },
    ...(ctx.role === "student" ? [{ href: "/grades", label: "My grades" }] : []),
    ...(ctx.isStaff ? [{ href: "/members", label: "Members" }] : []),
    ...(ctx.isAdmin ? [{ href: "/lms", label: "LMS" }] : []),
    ...(ctx.isAdmin ? [{ href: "/records", label: "Records" }] : []),
  ];
  return (
    <AppShell
      session={ctx.session}
      current={slug}
      notifications={{ unread: unread ?? 0, href: `/i/${slug}/notifications` }}
    >
      <PageTitle
        title={ctx.institution.name}
        subtitle={
          <span className="inline-flex items-center gap-2">
            You are <Badge tone={roleTone(ctx.role)}>{ctx.role}</Badge>
            {ctx.institution.status !== "active" && (
              <Badge tone="warning">{ctx.institution.status.replace("_", " ")}</Badge>
            )}
          </span>
        }
      />
      <InstitutionNav slug={slug} tabs={tabs} />
      {children}
    </AppShell>
  );
}
