import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AuditLogView } from "@/components/audit-log";
import { auditFilters, loadAudit } from "@/lib/audit";
import { requireMembership } from "@/lib/institution";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Audit log" };

const PAGE = 50;

export default async function AuditPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const ctx = await requireMembership(slug);
  if (!ctx.isAdmin) notFound();
  const filters = auditFilters(query);
  const { rows, actors, noSuchActor } = await loadAudit(
    await createSupabaseServerClient(),
    ctx.institution.id,
    filters,
    PAGE + 1,
  );
  return (
    <AuditLogView
      basePath={`/i/${slug}/audit`}
      filters={filters}
      rows={rows}
      actors={actors}
      pageSize={PAGE}
      noSuchActor={noSuchActor}
    />
  );
}
