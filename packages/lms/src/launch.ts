import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { CLAIM, courseRoleFromLti, isLmsAdministrator, type CourseRole } from "./claims.ts";
import { LtiError } from "./errors.ts";
import type { Platform } from "./platform.ts";

export type MessageType = "LtiResourceLinkRequest" | "LtiDeepLinkingRequest";

/** A verified launch: who, from which course and link, and which LTI services it offers. */
export interface Launch {
  messageType: MessageType;
  deploymentId: string;
  /** The platform's stable user id (`sub`). */
  userId: string;
  email: string | null;
  name: string | null;
  roles: string[];
  courseRole: CourseRole | null;
  lmsAdmin: boolean;
  context: { id: string; title: string | null; label: string | null } | null;
  resourceLink: { id: string; title: string | null } | null;
  custom: Record<string, string>;
  targetLinkUri: string | null;
  /** Names and Role Provisioning Services (roster). */
  nrps: { membershipsUrl: string } | null;
  /** Assignment and Grade Services (grade passback). */
  ags: { lineItemsUrl: string | null; lineItemUrl: string | null; scopes: string[] } | null;
  deepLinking: { returnUrl: string; acceptTypes: string[]; data: string | null } | null;
  claims: JWTPayload;
}

const jwksCache = new Map<string, JWTVerifyGetKey>();
const remoteJwks = (url: string) => {
  let jwks = jwksCache.get(url);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(url), { timeoutDuration: 10_000, cooldownDuration: 30_000 });
    jwksCache.set(url, jwks);
  }
  return jwks;
};

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** The platform (issuer, client) an id_token claims to come from, before verifying it. */
export function peekIssuer(idToken: string): { issuer: string | null; audience: string[] } {
  try {
    const claims = decodeJwt(idToken);
    const aud = claims.aud === undefined ? [] : Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    return { issuer: claims.iss ?? null, audience: aud };
  } catch {
    return { issuer: null, audience: [] };
  }
}

/**
 * Verifies an LTI 1.3 launch id_token (LTI Core §5.1.3): the platform's signature, issuer and
 * audience (and azp with several audiences), expiry, the nonce from the login, the LTI
 * version, a known deployment (any, when the connection lists none: the client ID is the
 * institution's own) and a supported message type.
 */
export async function verifyLaunch(
  idToken: string,
  platform: Platform,
  { nonce, jwks, now }: { nonce: string; jwks?: JWTVerifyGetKey; now?: Date },
): Promise<Launch> {
  let claims: JWTPayload;
  try {
    ({ payload: claims } = await jwtVerify(idToken, jwks ?? remoteJwks(platform.jwksUrl), {
      issuer: platform.issuer,
      audience: platform.clientId,
      algorithms: ["RS256", "RS384", "RS512", "ES256"],
      clockTolerance: 60,
      currentDate: now,
      requiredClaims: ["sub", "exp", "iat", "nonce"],
    }));
  } catch (err) {
    throw new LtiError("invalid_token", `The launch could not be verified: ${(err as Error).message}`);
  }
  if (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== platform.clientId) {
    throw new LtiError("invalid_token", "The launch is meant for another tool (azp).");
  }
  if (claims.nonce !== nonce) throw new LtiError("invalid_nonce", "The launch doesn't match the login (nonce).");
  if (claims[CLAIM.version] !== "1.3.0")
    throw new LtiError("unsupported_version", "Only LTI 1.3 launches are supported.");
  const deploymentId = str(claims[CLAIM.deploymentId]);
  if (!deploymentId || (platform.deploymentIds.length > 0 && !platform.deploymentIds.includes(deploymentId))) {
    throw new LtiError(
      "unknown_deployment",
      `This tool deployment (${deploymentId ?? "none"}) isn't registered. Ask your platform admin to add it.`,
    );
  }
  const messageType = claims[CLAIM.messageType];
  if (messageType !== "LtiResourceLinkRequest" && messageType !== "LtiDeepLinkingRequest") {
    throw new LtiError("unsupported_message", `Unsupported LTI message type: ${String(messageType)}`);
  }

  const context = obj(claims[CLAIM.context]);
  const resourceLink = obj(claims[CLAIM.resourceLink]);
  if (messageType === "LtiResourceLinkRequest" && !str(resourceLink?.id)) {
    throw new LtiError("invalid_launch", "The launch has no resource link.");
  }
  const roles = Array.isArray(claims[CLAIM.roles])
    ? ((claims[CLAIM.roles] as unknown[]).filter((r) => typeof r === "string") as string[])
    : [];
  const custom = Object.fromEntries(
    Object.entries(obj(claims[CLAIM.custom]) ?? {}).flatMap(([k, v]) => (typeof v === "string" ? [[k, v]] : [])),
  );
  const nrps = obj(claims[CLAIM.nrps]);
  const ags = obj(claims[CLAIM.ags]);
  const dl = obj(claims[CLAIM.deepLinkingSettings]);
  if (messageType === "LtiDeepLinkingRequest" && !str(dl?.deep_link_return_url)) {
    throw new LtiError("invalid_launch", "The deep linking request has no return URL.");
  }

  return {
    messageType,
    deploymentId,
    userId: claims.sub!,
    email: str(claims.email)?.toLowerCase() ?? null,
    name: str(claims.name) ?? ([str(claims.given_name), str(claims.family_name)].filter(Boolean).join(" ") || null),
    roles,
    courseRole: courseRoleFromLti(roles),
    lmsAdmin: isLmsAdministrator(roles),
    context: str(context?.id)
      ? { id: str(context!.id)!, title: str(context!.title), label: str(context!.label) }
      : null,
    resourceLink: str(resourceLink?.id) ? { id: str(resourceLink!.id)!, title: str(resourceLink!.title) } : null,
    custom,
    targetLinkUri: str(claims[CLAIM.targetLinkUri]),
    nrps: str(nrps?.context_memberships_url) ? { membershipsUrl: str(nrps!.context_memberships_url)! } : null,
    ags: ags
      ? {
          lineItemsUrl: str(ags.lineitems),
          lineItemUrl: str(ags.lineitem),
          scopes: Array.isArray(ags.scope)
            ? ((ags.scope as unknown[]).filter((s) => typeof s === "string") as string[])
            : [],
        }
      : null,
    deepLinking: dl
      ? {
          returnUrl: str(dl.deep_link_return_url)!,
          acceptTypes: Array.isArray(dl.accept_types) ? (dl.accept_types as string[]) : [],
          data: str(dl.data),
        }
      : null,
    claims,
  };
}
