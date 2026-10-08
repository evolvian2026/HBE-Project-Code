import type { Actor, InstitutionRole, InstitutionStatus } from "@hbe/core";
import type { Db } from "@hbe/db";
import { createClient } from "@supabase/supabase-js";
import type { FastifyRequest } from "fastify";
import { unauthorized } from "./errors.ts";

export interface VerifiedToken {
  userId: string;
  /** Authenticator assurance level: aal2 once the user has passed MFA. */
  aal: string | null;
}

export interface TokenVerifier {
  verify(accessToken: string): Promise<VerifiedToken | null>;
}

/**
 * Verifies Supabase access tokens. With asymmetric signing keys this is a local
 * check against the cached JWKS; with a shared secret it asks Supabase Auth.
 */
export function supabaseTokenVerifier(supabaseUrl: string, publishableKey: string): TokenVerifier {
  const client = createClient(supabaseUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return {
    async verify(accessToken) {
      const { data, error } = await client.auth.getClaims(accessToken);
      const claims = data?.claims;
      if (error || !claims?.sub || claims.role !== "authenticated") return null;
      return { userId: claims.sub, aal: typeof claims.aal === "string" ? claims.aal : null };
    },
  };
}

/**
 * Builds the actor from the database, never from token claims, so role changes
 * and deactivations take effect immediately.
 */
export async function loadActor(db: Db, userId: string, aal: string | null): Promise<Actor | null> {
  const [profile, superAdmin, memberships, mfaSetting] = await Promise.all([
    db.selectFrom("profiles").select(["id", "status", "github_user_id"]).where("id", "=", userId).executeTakeFirst(),
    db
      .selectFrom("user_roles")
      .select("role")
      .where("user_id", "=", userId)
      .where("role", "=", "super_admin")
      .executeTakeFirst(),
    db
      .selectFrom("institution_memberships as m")
      .innerJoin("institutions as i", "i.id", "m.institution_id")
      .select(["m.institution_id", "m.role", "i.status"])
      .where("m.user_id", "=", userId)
      .where("m.status", "=", "active")
      .where("i.status", "in", ["active", "read_only"])
      .execute(),
    db.selectFrom("platform_settings").select("value").where("key", "=", "require_admin_mfa").executeTakeFirst(),
  ]);
  if (!profile || profile.status !== "active") return null;

  // Same rule as private.admin_mfa_ok() in the database.
  const mfaSatisfied = aal === "aal2" || mfaSetting?.value === false;
  return {
    userId,
    isSuperAdmin: Boolean(superAdmin) && mfaSatisfied,
    mfaSatisfied,
    githubUserId: profile.github_user_id,
    memberships: new Map(
      memberships.map((m) => [
        m.institution_id,
        { role: m.role as InstitutionRole, institutionStatus: m.status as InstitutionStatus },
      ]),
    ),
  };
}

export async function authenticate(req: FastifyRequest, db: Db, verifier: TokenVerifier): Promise<Actor> {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : null;
  if (!token) throw unauthorized();
  const verified = await verifier.verify(token);
  if (!verified) throw unauthorized("Session expired or invalid");
  const actor = await loadActor(db, verified.userId, verified.aal);
  if (!actor) throw unauthorized("Account is not active");
  return actor;
}
