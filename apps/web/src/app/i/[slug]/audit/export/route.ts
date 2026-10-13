import { notFound } from "next/navigation";
import { auditFilters } from "@/lib/audit";
import { auditCsv } from "@/lib/audit-csv";
import { requireMembership } from "@/lib/institution";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/** Institution admins download their audit log (with the page's filters) as CSV. */
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ctx = await requireMembership(slug);
  if (!ctx.isAdmin) notFound();
  const query = Object.fromEntries(new URL(req.url).searchParams);
  return auditCsv(await createSupabaseServerClient(), ctx.institution.id, auditFilters(query), `audit-${slug}.csv`);
}
