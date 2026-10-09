import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { CLAIM } from "./claims.ts";
import type { ToolKey } from "./keys.ts";
import type { Platform } from "./platform.ts";

/** A link to one of the tool's resources, as the LMS will place it (LTI Deep Linking §3.4.1). */
export interface ResourceLinkItem {
  title: string;
  text?: string;
  url: string;
  custom?: Record<string, string>;
  /** Asks the LMS to create a gradebook column for the link. */
  lineItem?: { label: string; scoreMaximum: number; resourceId: string; tag?: string };
}

/**
 * The signed LtiDeepLinkingResponse the browser posts back to the platform's
 * deep_link_return_url (LTI Deep Linking §4.2).
 */
export async function deepLinkingResponse(
  key: ToolKey,
  platform: Pick<Platform, "issuer" | "clientId">,
  o: { deploymentId: string; data: string | null; items: ResourceLinkItem[]; message?: string },
): Promise<string> {
  return new SignJWT({
    nonce: randomUUID(),
    [CLAIM.messageType]: "LtiDeepLinkingResponse",
    [CLAIM.version]: "1.3.0",
    [CLAIM.deploymentId]: o.deploymentId,
    [CLAIM.deepLinkingContentItems]: o.items.map((item) => ({ type: "ltiResourceLink", ...item })),
    ...(o.data ? { [CLAIM.deepLinkingData]: o.data } : {}),
    ...(o.message ? { "https://purl.imsglobal.org/spec/lti-dl/claim/msg": o.message } : {}),
  })
    .setProtectedHeader({ alg: "RS256", kid: key.kid, typ: "JWT" })
    .setIssuer(platform.clientId)
    .setAudience(platform.issuer)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(key.privateKey);
}
