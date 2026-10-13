import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { webConfig } from "../config";

/** A Supabase client acting as the signed-in user (RLS applies). Create one per request. */
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
  const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, APP_URL } = webConfig();
  return createServerClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    // Session cookies only travel over HTTPS once the site is served over it.
    cookieOptions: { secure: APP_URL.startsWith("https://") },
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) cookieStore.set(name, value, options);
        } catch {
          // Server Components can't set cookies; the middleware refreshes the session instead.
        }
      },
    },
  });
}
