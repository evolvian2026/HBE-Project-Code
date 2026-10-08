import type { ReactNode } from "react";
import { AppShell, PageTitle } from "@/components/app-shell";
import { InstitutionNav } from "@/components/institution-nav";
import { Badge, roleTone } from "@/components/ui";
import { requireMembership } from "@/lib/institution";

export default async function InstitutionLayout({
  params,
  children,
}: {
  params: Promise<{ slug: string }>;
  children: ReactNode;
}) {
  const { slug } = await params;
  const ctx = await requireMembership(slug);
  const tabs = [
    { href: "", label: "Overview" },
    { href: "/courses", label: ctx.role === "student" ? "My courses" : "Courses" },
    ...(ctx.isStaff ? [{ href: "/members", label: "Members" }] : []),
  ];
  return (
    <AppShell session={ctx.session} current={slug}>
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
