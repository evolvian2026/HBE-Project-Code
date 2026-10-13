import type { Settings } from "@hbe/settings";
import { createClient } from "@supabase/supabase-js";

/** Supabase Auth's admin API for a person's two-factor factors. */
export interface MfaAdmin {
  /** Removes every factor the person enrolled; returns how many. */
  removeFactors(userId: string): Promise<number>;
}

export function supabaseMfaAdmin(settings: Settings): MfaAdmin {
  const client = createClient(settings.env.SUPABASE_URL, settings.env.SUPABASE_SECRET_KEY ?? "", {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return {
    async removeFactors(userId) {
      const { data, error } = await client.auth.admin.mfa.listFactors({ userId });
      if (error) throw new Error(`Could not list the factors: ${error.message}`);
      for (const factor of data.factors) {
        const removed = await client.auth.admin.mfa.deleteFactor({ id: factor.id, userId });
        if (removed.error) throw new Error(`Could not remove a factor: ${removed.error.message}`);
      }
      return data.factors.length;
    },
  };
}
