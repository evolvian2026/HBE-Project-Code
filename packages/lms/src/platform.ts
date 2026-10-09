import { z } from "zod";

/** What the tool knows about one LMS registration (a row of lms_connections). */
export interface Platform {
  issuer: string;
  clientId: string;
  /** Deployments of the tool the platform may launch from (empty: any deployment of this client). */
  deploymentIds: string[];
  authLoginUrl: string;
  authTokenUrl: string;
  jwksUrl: string;
}

/** The third-party OIDC login request a platform starts a launch with (GET or POST). */
export const loginRequestSchema = z.object({
  iss: z.string().url(),
  login_hint: z.string().min(1).max(2000),
  target_link_uri: z.string().url(),
  lti_message_hint: z.string().max(4000).optional(),
  client_id: z.string().min(1).max(500).optional(),
  lti_deployment_id: z.string().min(1).max(500).optional(),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** Where to send the browser for the platform's OIDC authentication (form_post of an id_token). */
export function authRedirectUrl(
  platform: Platform,
  req: LoginRequest,
  { redirectUri, state, nonce }: { redirectUri: string; state: string; nonce: string },
): string {
  const url = new URL(platform.authLoginUrl);
  const params: Record<string, string | undefined> = {
    scope: "openid",
    response_type: "id_token",
    response_mode: "form_post",
    prompt: "none",
    client_id: platform.clientId,
    redirect_uri: redirectUri,
    login_hint: req.login_hint,
    lti_message_hint: req.lti_message_hint,
    state,
    nonce,
  };
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  return url.toString();
}
