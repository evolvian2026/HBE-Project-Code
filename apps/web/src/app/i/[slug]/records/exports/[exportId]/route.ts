import { apiFetch } from "@/lib/api";
import { requireMembership } from "@/lib/institution";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Downloads a finished export through a short-lived URL from the API (admins only). */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string; exportId: string }> }) {
  const { slug, exportId } = await params;
  await requireMembership(slug);
  if (!UUID.test(exportId)) return new Response("Not found", { status: 404 });
  const result = await apiFetch<{ url: string }>(`/v1/record-exports/${exportId}/download`);
  if (!result.ok) return new Response(result.message, { status: result.status });
  return Response.redirect(result.data.url, 302);
}
