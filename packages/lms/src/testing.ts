/**
 * A stand-in LTI 1.3 platform (an LMS) for tests: it has its own signing key and JWKS, and
 * signs launch id_tokens with the claims a real platform sends. `serve()` also answers the
 * OIDC authentication request over HTTP (auto-posting the id_token to the tool), so browser
 * tests can run a whole launch.
 */
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";
import { CLAIM } from "./claims.ts";

export interface TestUser {
  sub: string;
  email?: string;
  name?: string;
  roles: string[];
}

export const ROLES = {
  instructor: "http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor",
  ta: "http://purl.imsglobal.org/vocab/lis/v2/membership/Instructor#TeachingAssistant",
  learner: "http://purl.imsglobal.org/vocab/lis/v2/membership#Learner",
  admin: "http://purl.imsglobal.org/vocab/lis/v2/institution/person#Administrator",
} as const;

export interface LaunchOptions {
  user: TestUser;
  nonce: string;
  clientId: string;
  deploymentId: string;
  messageType?: "LtiResourceLinkRequest" | "LtiDeepLinkingRequest";
  context?: { id: string; title?: string; label?: string };
  resourceLink?: { id: string; title?: string };
  custom?: Record<string, string>;
  targetLinkUri?: string;
  extra?: Record<string, unknown>;
  expiresInSeconds?: number;
}

export class TestPlatform {
  private constructor(
    readonly issuer: string,
    private readonly key: CryptoKey,
    readonly publicJwk: JWK,
  ) {}

  static async create(issuer = `https://lms-${randomUUID().slice(0, 8)}.test`): Promise<TestPlatform> {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    return new TestPlatform(issuer, privateKey, { ...(await exportJWK(publicKey)), kid: "platform-1", alg: "RS256" });
  }

  get jwks() {
    return { keys: [this.publicJwk] };
  }

  /** For verifyLaunch without HTTP. */
  get localJwks() {
    return createLocalJWKSet(this.jwks);
  }

  /** A signed launch id_token. */
  async idToken(o: LaunchOptions): Promise<string> {
    const messageType = o.messageType ?? "LtiResourceLinkRequest";
    const claims: Record<string, unknown> = {
      nonce: o.nonce,
      email: o.user.email,
      name: o.user.name,
      [CLAIM.messageType]: messageType,
      [CLAIM.version]: "1.3.0",
      [CLAIM.deploymentId]: o.deploymentId,
      [CLAIM.targetLinkUri]: o.targetLinkUri ?? "https://tool.test/lti/launch",
      [CLAIM.roles]: o.user.roles,
      ...(o.context ? { [CLAIM.context]: o.context } : {}),
      ...(messageType === "LtiResourceLinkRequest"
        ? { [CLAIM.resourceLink]: o.resourceLink ?? { id: `link-${randomUUID()}` } }
        : {
            [CLAIM.deepLinkingSettings]: {
              deep_link_return_url: `${this.issuer}/deep-link-return`,
              accept_types: ["ltiResourceLink"],
              accept_presentation_document_targets: ["iframe", "window"],
            },
          }),
      ...(o.custom ? { [CLAIM.custom]: o.custom } : {}),
      ...o.extra,
    };
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: this.publicJwk.kid })
      .setIssuer(this.issuer)
      .setSubject(o.user.sub)
      .setAudience(o.clientId)
      .setIssuedAt()
      .setExpirationTime(`${o.expiresInSeconds ?? 300}s`)
      .sign(this.key);
  }

  /**
   * Serves the platform over HTTP: GET /jwks and the OIDC authentication endpoint GET /auth,
   * which answers with a page that auto-posts the id_token (for `nextLaunch`) to the tool.
   * The issuer of a served platform is its URL.
   */
  static async serve(): Promise<ServedPlatform> {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const publicJwk = { ...(await exportJWK(publicKey)), kid: "platform-1", alg: "RS256" };
    let next: Omit<LaunchOptions, "nonce" | "clientId"> | null = null;
    const requests: URL[] = [];
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", platform.issuer);
      requests.push(url);
      if (url.pathname === "/jwks") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(platform.jwks));
        return;
      }
      if (url.pathname === "/auth") {
        if (!next) {
          res.writeHead(400).end("No launch prepared");
          return;
        }
        const launch = next;
        void platform
          .idToken({ ...launch, nonce: url.searchParams.get("nonce")!, clientId: url.searchParams.get("client_id")! })
          .then((token) => {
            const html = `<!doctype html><title>LMS</title><form method="post" action="${url.searchParams.get("redirect_uri")}">
<input type="hidden" name="id_token" value="${token}"><input type="hidden" name="state" value="${url.searchParams.get("state")}">
</form><script>document.forms[0].submit()</script>`;
            res.writeHead(200, { "content-type": "text/html" }).end(html);
          });
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    const platform = new TestPlatform(`http://127.0.0.1:${address.port}`, privateKey, publicJwk);
    return Object.assign(platform, {
      authUrl: `${platform.issuer}/auth`,
      jwksUrl: `${platform.issuer}/jwks`,
      requests,
      prepare(launch: Omit<LaunchOptions, "nonce" | "clientId">) {
        next = launch;
      },
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    });
  }
}

export type ServedPlatform = TestPlatform & {
  authUrl: string;
  jwksUrl: string;
  requests: URL[];
  /** The user and context of the next launch the auth endpoint answers. */
  prepare(launch: Omit<LaunchOptions, "nonce" | "clientId">): void;
  close(): Promise<void>;
};
