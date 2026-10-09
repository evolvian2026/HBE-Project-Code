import type { Settings } from "@hbe/settings";
import { createClient } from "@supabase/supabase-js";

/** Signing people in after an LMS launch (Supabase Auth's admin API). */
export interface SignInService {
  /** Creates a confirmed account for this email (someone invited who hasn't signed in yet). */
  createUser(email: string, name: string | null): Promise<string>;
  /** A one-time token hash; the web app exchanges it for a session (verifyOtp). */
  signInToken(email: string): Promise<string>;
}

export function supabaseSignIn(settings: Settings): SignInService {
  const client = createClient(settings.env.SUPABASE_URL, settings.env.SUPABASE_SECRET_KEY ?? "", {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return {
    async createUser(email, name) {
      const { data, error } = await client.auth.admin.createUser({
        email,
        email_confirm: true,
        user_metadata: name ? { full_name: name } : {},
      });
      if (error || !data.user) throw new Error(`Could not create the account: ${error?.message}`);
      return data.user.id;
    },
    async signInToken(email) {
      const { data, error } = await client.auth.admin.generateLink({ type: "magiclink", email });
      if (error || !data.properties?.hashed_token) throw new Error(`Could not sign in: ${error?.message}`);
      return data.properties.hashed_token;
    },
  };
}
