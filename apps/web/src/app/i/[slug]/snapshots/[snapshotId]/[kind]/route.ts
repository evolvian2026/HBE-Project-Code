import { requireMembership } from "@/lib/institution";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Downloads the archived source of a graded commit (tarball or git bundle), through Storage RLS. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string; snapshotId: string; kind: string }> },
) {
  const { slug, snapshotId, kind } = await params;
  const ctx = await requireMembership(slug);
  if (!UUID.test(snapshotId) || (kind !== "tarball" && kind !== "bundle")) {
    return new Response("Not found", { status: 404 });
  }
  const supabase = await createSupabaseServerClient();
  const { data: snapshot } = await supabase
    .from("submission_snapshots")
    .select("sha, bundle_path, tarball_path")
    .eq("id", snapshotId)
    .eq("institution_id", ctx.institution.id)
    .maybeSingle();
  if (!snapshot) return new Response("Not found", { status: 404 });

  const path = kind === "bundle" ? snapshot.bundle_path : snapshot.tarball_path;
  const filename = `${snapshot.sha.slice(0, 12)}.${kind === "bundle" ? "bundle" : "tar.gz"}`;
  const { data, error } = await supabase.storage
    .from("submission-archive")
    .createSignedUrl(path, 60, { download: filename });
  if (error || !data) return new Response("The archive is not available.", { status: 404 });
  return Response.redirect(data.signedUrl, 302);
}
