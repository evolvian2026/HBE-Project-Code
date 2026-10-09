import type { createSupabaseServerClient } from "./supabase/server";

type Supabase = Awaited<ReturnType<typeof createSupabaseServerClient>>;

/**
 * The submissions of a submission's team on its assignment (itself included); itself alone for
 * individual work. Team work (runs, files, code comments) is shared across these.
 */
export async function teamSubmissionIds(
  supabase: Supabase,
  s: { id: string; assignment_id: string; team_id: string | null },
): Promise<string[]> {
  if (!s.team_id) return [s.id];
  const { data } = await supabase
    .from("submissions")
    .select("id")
    .eq("assignment_id", s.assignment_id)
    .eq("team_id", s.team_id);
  const ids = (data ?? []).map((r) => r.id as string);
  return ids.includes(s.id) ? ids : [s.id, ...ids];
}
