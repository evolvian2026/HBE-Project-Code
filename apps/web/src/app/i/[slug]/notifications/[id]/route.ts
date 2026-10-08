import { requireMembership } from "@/lib/institution";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Opens a notification: marks it read (RLS: only your own) and goes where it points. */
export async function GET(req: Request, { params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params;
  await requireMembership(slug);
  const back = new URL(`/i/${slug}/notifications`, req.url);
  if (!UUID.test(id)) return Response.redirect(back, 302);
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", id)
    .select("link")
    .maybeSingle();
  // Links are app paths written by the platform; anything else goes back to the list.
  const target = data?.link?.startsWith("/") && !data.link.startsWith("//") ? new URL(data.link, req.url) : back;
  return Response.redirect(target, 302);
}
