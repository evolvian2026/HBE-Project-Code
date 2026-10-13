import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell, PageTitle } from "@/components/app-shell";
import { AuditLogView } from "@/components/audit-log";
import { auditFilters, loadAudit } from "@/lib/audit";
import { enforceAdminMfa } from "@/lib/mfa";
import { requireSession } from "@/lib/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Platform audit log" };

const PAGE = 50;

/** Platform-level changes (institutions created, platform roles, settings, installations). */
export default async function PlatformAuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const [session, query] = await Promise.all([requireSession(), searchParams]);
  if (!session.isSuperAdmin) notFound();
  await enforceAdminMfa("/platform/audit");
  const filters = auditFilters(query);
  const { rows, actors, noSuchActor } = await loadAudit(await createSupabaseServerClient(), null, filters, PAGE + 1);
  return (
    <AppShell session={session}>
      <PageTitle
        title="Platform audit log"
        subtitle={
          <>
            Changes outside any institution. Each institution&apos;s own log is for its admins.{" "}
            <Link href="/platform" className="link">
              Back to the console
            </Link>
          </>
        }
      />
      <AuditLogView
        basePath="/platform/audit"
        filters={filters}
        rows={rows}
        actors={actors}
        pageSize={PAGE}
        noSuchActor={noSuchActor}
      />
    </AppShell>
  );
}
