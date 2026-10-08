import { requireMembership } from "@/lib/institution";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Downloads a grade report (pdf or json). The signed URL is created with the user's own
 * session, so Storage's row-level security decides: course staff, or the student once released.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string; reportId: string; format: string }> },
) {
  const { slug, reportId, format } = await params;
  const ctx = await requireMembership(slug);
  if (!UUID.test(reportId) || (format !== "pdf" && format !== "json"))
    return new Response("Not found", { status: 404 });

  const supabase = await createSupabaseServerClient();
  const { data: report } = await supabase
    .from("grade_reports")
    .select("json_path, pdf_path, version, submission_id")
    .eq("id", reportId)
    .eq("institution_id", ctx.institution.id)
    .maybeSingle();
  if (!report) return new Response("Not found", { status: 404 });

  const path = format === "pdf" ? report.pdf_path : report.json_path;
  const { data, error } = await supabase.storage
    .from("grade-reports")
    .createSignedUrl(path, 60, { download: `grade-report-v${report.version}.${format}` });
  if (error || !data) return new Response("The report file is not available yet.", { status: 404 });
  return Response.redirect(data.signedUrl, 302);
}
