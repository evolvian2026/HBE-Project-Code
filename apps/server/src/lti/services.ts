import { LtiError, LtiServices } from "@hbe/lms";
import type { Settings } from "@hbe/settings";
import { platformOf } from "./platform.ts";
import { toolKeys } from "./keys.ts";

export interface ConnectionRow {
  id: string;
  issuer: string | null;
  client_id: string | null;
  deployment_ids: string[];
  auth_login_url: string | null;
  auth_token_url: string | null;
  jwks_url: string | null;
}

const clients = new Map<string, { key: string; client: LtiServices }>();

/** The LTI Advantage client of a connection (kept, with its access tokens, per process). */
export async function servicesFor(settings: Settings, conn: ConnectionRow): Promise<LtiServices> {
  const keys = await toolKeys(settings);
  if (!keys) throw new LtiError("not_configured", "The platform's LTI key (LTI_PRIVATE_KEY_BASE64) isn't set.");
  const key = [conn.issuer, conn.client_id, conn.auth_token_url, keys.current.kid].join("|");
  const cached = clients.get(conn.id);
  if (cached?.key === key) return cached.client;
  const client = new LtiServices(platformOf(conn), keys.current);
  clients.set(conn.id, { key, client });
  return client;
}
