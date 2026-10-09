import { requireMembership } from "@/lib/institution";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A run's file (a log, a JUnit report, a screenshot or a trace). The signed URL is created with
 * the user's own session, so row-level security decides: whoever can see the run. Images and
 * text open in the browser; other files download.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string; runId: string; name: string[] }> },
) {
  const { slug, runId, name } = await params;
  const ctx = await requireMembership(slug);
  if (!UUID.test(runId)) return new Response("Not found", { status: 404 });

  const supabase = await createSupabaseServerClient();
  const { data: file } = await supabase
    .from("run_artifacts")
    .select("path, content_type")
    .eq("run_id", runId)
    .eq("name", name.map(decodeURIComponent).join("/"))
    .eq("institution_id", ctx.institution.id)
    .maybeSingle();
  if (!file) return new Response("Not found", { status: 404 });

  const inline = file.content_type === "image/png" || file.content_type === "text/plain";
  const { data, error } = await supabase.storage
    .from("run-artifacts")
    .createSignedUrl(file.path, 60, inline ? undefined : { download: file.path.split("/").at(-1)! });
  if (error || !data) return new Response("This file is no longer available.", { status: 404 });
  return Response.redirect(data.signedUrl, 302);
}
