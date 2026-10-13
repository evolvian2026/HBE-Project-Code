import type { RealtimeAuth } from "@/components/live-runs";
import { webConfig } from "./config";
import type { createSupabaseServerClient } from "./supabase/server";

/**
 * The signed-in person's access token (already readable by the page's scripts, in the session
 * cookie) with the project's public address and key, for live updates in the browser.
 */
export async function realtimeAuth(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
): Promise<RealtimeAuth | null> {
  const { data } = await supabase.auth.getSession();
  if (!data.session) return null;
  const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } = webConfig();
  return { url: SUPABASE_URL, key: SUPABASE_PUBLISHABLE_KEY, token: data.session.access_token };
}

/** A Realtime filter for these ids (Realtime accepts up to 100 values in `in`). */
export const inFilter = (column: string, ids: string[]) => `${column}=in.(${ids.slice(0, 100).join(",")})`;
