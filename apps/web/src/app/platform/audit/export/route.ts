import { notFound } from "next/navigation";
import { auditFilters } from "@/lib/audit";
import { auditCsv } from "@/lib/audit-csv";
import { requireSession } from "@/lib/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/** Super admins download the platform audit log as CSV (RLS also requires their MFA). */
export async function GET(req: Request) {
  const session = await requireSession();
  if (!session.isSuperAdmin) notFound();
  const query = Object.fromEntries(new URL(req.url).searchParams);
  return auditCsv(await createSupabaseServerClient(), null, auditFilters(query), "audit-platform.csv");
}
