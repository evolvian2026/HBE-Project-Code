import { z } from "zod";
import { SCOPE } from "./claims.ts";
import { LtiError } from "./errors.ts";

/** The platform's OpenID configuration (LTI Dynamic Registration §3.4). */
const platformConfigSchema = z.object({
  issuer: z.string().url(),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  jwks_uri: z.string().url(),
  registration_endpoint: z.string().url(),
  "https://purl.imsglobal.org/spec/lti-platform-configuration": z
    .object({ product_family_code: z.string().optional(), version: z.string().optional() })
    .passthrough()
    .optional(),
});

export interface ToolDescription {
  name: string;
  description: string;
  /** e.g. https://api.example.com */
  apiUrl: string;
  logoUrl?: string;
}

/** What a successful registration gives the tool: a new lms_connections row. */
export interface Registered {
  issuer: string;
  clientId: string;
  deploymentId: string | null;
  authLoginUrl: string;
  authTokenUrl: string;
  jwksUrl: string;
  productFamily: string | null;
  response: unknown;
}

/** Whether a URL is under the issuer: same origin, and below the issuer's path if it has one. */
function servedByIssuer(url: string, issuer: string): boolean {
  try {
    const u = new URL(url);
    const iss = new URL(issuer);
    const base = iss.pathname.replace(/\/$/, "");
    return u.origin === iss.origin && (base === "" || u.pathname === base || u.pathname.startsWith(`${base}/`));
  } catch {
    return false;
  }
}

/** The tool's endpoints (what admins type in for a manual registration, too). */
export function toolEndpoints(apiUrl: string) {
  const base = apiUrl.replace(/\/$/, "");
  return {
    loginUrl: `${base}/lti/login`,
    launchUrl: `${base}/lti/launch`,
    jwksUrl: `${base}/.well-known/jwks.json`,
    registrationUrl: `${base}/lti/register`,
  };
}

/**
 * LTI Dynamic Registration (IMS, 1.0): reads the platform's configuration and registers the
 * tool with it. The registration token comes from the platform's request; it's single-use.
 */
export async function registerWithPlatform(
  openidConfigurationUrl: string,
  registrationToken: string | null,
  tool: ToolDescription,
  fetchImpl: typeof fetch = fetch,
): Promise<Registered> {
  const auth: Record<string, string> = registrationToken ? { authorization: `Bearer ${registrationToken}` } : {};
  const res = await fetchImpl(openidConfigurationUrl, { headers: { accept: "application/json", ...auth } });
  if (!res.ok)
    throw new LtiError("registration_failed", `The LMS configuration could not be read (HTTP ${res.status}).`);
  const parsed = platformConfigSchema.safeParse(await res.json());
  if (!parsed.success) throw new LtiError("registration_failed", "The LMS configuration is incomplete.");
  const config = parsed.data;
  const productFamily = config["https://purl.imsglobal.org/spec/lti-platform-configuration"]?.product_family_code;
  // The configuration must come from the issuer it names (Dynamic Registration §3.5.1). Canvas
  // is the exception: every Canvas Cloud school serves it from its own domain under the shared
  // issuer https://canvas.instructure.com. The one-time invite URL is what authorises the
  // registration either way.
  if (productFamily !== "canvas" && !servedByIssuer(openidConfigurationUrl, config.issuer)) {
    throw new LtiError("registration_failed", "The LMS configuration's issuer doesn't match where it was read from.");
  }

  const endpoints = toolEndpoints(tool.apiUrl);
  const body = {
    application_type: "web",
    response_types: ["id_token"],
    grant_types: ["implicit", "client_credentials"],
    initiate_login_uri: endpoints.loginUrl,
    redirect_uris: [endpoints.launchUrl],
    client_name: tool.name,
    jwks_uri: endpoints.jwksUrl,
    ...(tool.logoUrl ? { logo_uri: tool.logoUrl } : {}),
    token_endpoint_auth_method: "private_key_jwt",
    scope: [SCOPE.lineItem, SCOPE.score, SCOPE.resultReadOnly, SCOPE.nrps].join(" "),
    "https://purl.imsglobal.org/spec/lti-tool-configuration": {
      domain: new URL(tool.apiUrl).host,
      description: tool.description,
      target_link_uri: endpoints.launchUrl,
      claims: ["iss", "sub", "name", "given_name", "family_name", "email"],
      messages: [
        { type: "LtiResourceLinkRequest" },
        { type: "LtiDeepLinkingRequest", target_link_uri: endpoints.launchUrl, label: tool.name },
      ],
    },
  };
  const reg = await fetchImpl(config.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", ...auth },
    body: JSON.stringify(body),
  });
  const response = (await reg.json().catch(() => null)) as Record<string, unknown> | null;
  if (!reg.ok || typeof response?.client_id !== "string") {
    throw new LtiError("registration_failed", `The LMS refused the registration (HTTP ${reg.status}).`);
  }
  const toolConfig = response["https://purl.imsglobal.org/spec/lti-tool-configuration"] as
    { deployment_id?: string } | undefined;
  return {
    issuer: config.issuer,
    clientId: response.client_id,
    deploymentId: toolConfig?.deployment_id ?? null,
    authLoginUrl: config.authorization_endpoint,
    authTokenUrl: config.token_endpoint,
    jwksUrl: config.jwks_uri,
    productFamily: productFamily ?? null,
    response,
  };
}
