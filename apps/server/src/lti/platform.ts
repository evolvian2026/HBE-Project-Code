import { createHash } from "node:crypto";
import type { Platform } from "@hbe/lms";

/** One-time URL tokens are stored as their SHA-256. */
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** The LTI platform of an lms_connections row. */
export const platformOf = (c: {
  issuer: string | null;
  client_id: string | null;
  deployment_ids: string[];
  auth_login_url: string | null;
  auth_token_url: string | null;
  jwks_url: string | null;
}): Platform => ({
  issuer: c.issuer!,
  clientId: c.client_id!,
  deploymentIds: c.deployment_ids,
  authLoginUrl: c.auth_login_url!,
  authTokenUrl: c.auth_token_url!,
  jwksUrl: c.jwks_url!,
});
