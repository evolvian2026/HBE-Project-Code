/**
 * A stand-in LTI 1.3 platform (an LMS) for tests: it has its own signing key and JWKS, and
 * signs launch id_tokens with the claims a real platform sends. `serve()` also runs it over
 * HTTP: the OIDC authentication endpoint (auto-posting the id_token to the tool), the token
 * endpoint, an AGS gradebook, an NRPS roster and the deep linking return URL, so integration
 * and browser tests can exercise the whole of LTI Advantage.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  exportJWK,
  generateKeyPair,
  jwtVerify,
  SignJWT,
  type CryptoKey,
  type JSONWebKeySet,
  type JWK,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";
import { CLAIM, SCOPE } from "./claims.ts";

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
  /** Include the AGS and NRPS claims for the context (served platforms answer them). */
  services?: boolean;
  /** The line item of the resource link (AGS `lineitem`). */
  lineItem?: string;
  extra?: Record<string, unknown>;
  expiresInSeconds?: number;
}

export class TestPlatform {
  protected constructor(
    protected issuerUrl: string,
    private readonly key: CryptoKey,
    readonly publicJwk: JWK,
  ) {}

  get issuer(): string {
    return this.issuerUrl;
  }

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

  lineItemsUrl(contextId: string) {
    return `${this.issuer}/contexts/${encodeURIComponent(contextId)}/lineitems`;
  }

  membershipsUrl(contextId: string) {
    return `${this.issuer}/contexts/${encodeURIComponent(contextId)}/memberships`;
  }

  /** A signed launch id_token. */
  async idToken(o: LaunchOptions): Promise<string> {
    const messageType = o.messageType ?? "LtiResourceLinkRequest";
    const services =
      o.services && o.context
        ? {
            [CLAIM.ags]: {
              scope: [SCOPE.lineItem, SCOPE.score, SCOPE.resultReadOnly],
              lineitems: this.lineItemsUrl(o.context.id),
              ...(o.lineItem ? { lineitem: o.lineItem } : {}),
            },
            [CLAIM.nrps]: { context_memberships_url: this.membershipsUrl(o.context.id), service_versions: ["2.0"] },
          }
        : {};
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
              deep_link_return_url: `${this.issuer}/deep-link-return${o.context ? `?context=${encodeURIComponent(o.context.id)}` : ""}`,
              accept_types: ["ltiResourceLink"],
              accept_presentation_document_targets: ["iframe", "window"],
              accept_multiple: true,
              data: "platform-data",
            },
          }),
      ...(o.custom ? { [CLAIM.custom]: o.custom } : {}),
      ...services,
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

  /** Runs the platform over HTTP on a free local port; its issuer is its URL. */
  static async serve(): Promise<ServedPlatform> {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const publicJwk = { ...(await exportJWK(publicKey)), kid: "platform-1", alg: "RS256" };
    const served = new ServedPlatform(privateKey, publicJwk);
    await served.listen();
    return served;
  }
}

export interface StoredLineItem {
  id: string;
  label: string;
  scoreMaximum: number;
  resourceId?: string;
  resourceLinkId?: string;
  tag?: string;
}

export interface TestMember {
  user_id: string;
  email?: string;
  name?: string;
  roles: string[];
  status?: "Active" | "Inactive" | "Deleted";
}

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => resolve(raw));
  });

/** A TestPlatform listening on HTTP, with a gradebook and a roster tests can inspect and change. */
export class ServedPlatform extends TestPlatform {
  private server: Server | null = null;
  private next: Omit<LaunchOptions, "nonce" | "clientId"> | null = null;
  private toolKeys: JWTVerifyGetKey | null = null;
  private readonly accessTokens = new Map<string, string[]>();
  readonly requests: URL[] = [];
  readonly tokenRequests: { clientId: string; scopes: string[] }[] = [];
  readonly lineItems = new Map<string, StoredLineItem>();
  /** Scores the tool posted, in order. */
  readonly scores: { lineItemId: string; score: Record<string, unknown> }[] = [];
  /** The gradebook: line item id → user id → result (a teacher may edit it with setResult). */
  readonly results = new Map<string, Map<string, { resultScore: number; resultMaximum: number }>>();
  readonly deepLinkResponses: JWTPayload[] = [];
  private members: TestMember[] = [];
  /** Members per NRPS page (tests pagination). */
  pageSize = 2;

  constructor(key: CryptoKey, publicJwk: JWK) {
    super("http://127.0.0.1:0", key, publicJwk);
  }

  /** The issuer: known once the server listens. */
  private get url() {
    return this.issuerUrl;
  }

  get authUrl() {
    return `${this.url}/auth`;
  }
  get tokenUrl() {
    return `${this.url}/token`;
  }
  get jwksUrl() {
    return `${this.url}/jwks`;
  }

  /** The user and context of the next launch the auth endpoint answers. */
  prepare(launch: Omit<LaunchOptions, "nonce" | "clientId">): void {
    this.next = launch;
  }

  /** Verify the tool's client assertions and deep linking responses with its JWKS (or JWKS URL). */
  trustTool(jwks: JSONWebKeySet | string): void {
    this.toolKeys = typeof jwks === "string" ? createRemoteJWKSet(new URL(jwks)) : createLocalJWKSet(jwks);
  }

  setMembers(members: TestMember[]): void {
    this.members = members;
  }

  /** A teacher changes a grade in the LMS gradebook. */
  setResult(lineItemId: string, userId: string, resultScore: number, resultMaximum = 100): void {
    if (!this.results.has(lineItemId)) this.results.set(lineItemId, new Map());
    this.results.get(lineItemId)!.set(userId, { resultScore, resultMaximum });
  }

  close(): Promise<void> {
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  async listen(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req).then(
        ({ status, body, type, headers }) =>
          res.writeHead(status, { "content-type": type ?? "application/json", ...headers }).end(body),
        (err: Error) => res.writeHead(500).end(err.message),
      );
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.issuerUrl = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
  }

  private authorized(req: IncomingMessage, scope: string): boolean {
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    return Boolean(token && this.accessTokens.get(token)?.includes(scope));
  }

  private async handle(
    req: IncomingMessage,
  ): Promise<{ status: number; body: string; type?: string; headers?: Record<string, string> }> {
    const url = new URL(req.url ?? "/", this.url);
    this.requests.push(url);
    const json = (status: number, value: unknown, headers?: Record<string, string>) => ({
      status,
      body: JSON.stringify(value),
      headers,
    });

    if (url.pathname === "/jwks") return json(200, this.jwks);

    if (url.pathname === "/auth") {
      if (!this.next) return { status: 400, body: "No launch prepared", type: "text/plain" };
      const token = await this.idToken({
        ...this.next,
        nonce: url.searchParams.get("nonce")!,
        clientId: url.searchParams.get("client_id")!,
      });
      const html = `<!doctype html><title>LMS</title><form method="post" action="${url.searchParams.get("redirect_uri")}">
<input type="hidden" name="id_token" value="${token}"><input type="hidden" name="state" value="${url.searchParams.get("state")}">
</form><script>document.forms[0].submit()</script>`;
      return { status: 200, body: html, type: "text/html" };
    }

    if (url.pathname === "/token" && req.method === "POST") {
      const form = new URLSearchParams(await readBody(req));
      const assertion = form.get("client_assertion") ?? "";
      let clientId = "";
      try {
        if (this.toolKeys) {
          const { payload } = await jwtVerify(assertion, this.toolKeys, { audience: this.tokenUrl });
          if (payload.iss !== payload.sub) throw new Error("iss and sub differ");
          clientId = payload.iss ?? "";
        } else {
          clientId = JSON.parse(Buffer.from(assertion.split(".")[1] ?? "", "base64url").toString()).iss;
        }
      } catch (err) {
        return json(401, { error: "invalid_client", error_description: (err as Error).message });
      }
      const scopes = (form.get("scope") ?? "").split(" ").filter(Boolean);
      this.tokenRequests.push({ clientId, scopes });
      const token = `tok-${randomUUID()}`;
      this.accessTokens.set(token, scopes);
      return json(200, { access_token: token, token_type: "Bearer", expires_in: 3600, scope: scopes.join(" ") });
    }

    if (url.pathname === "/deep-link-return" && req.method === "POST") {
      const jwt = new URLSearchParams(await readBody(req)).get("JWT") ?? "";
      if (!this.toolKeys) return { status: 500, body: "trustTool first", type: "text/plain" };
      const { payload } = await jwtVerify(jwt, this.toolKeys, { audience: this.url });
      this.deepLinkResponses.push(payload);
      // Like an LMS, make the gradebook columns the links ask for.
      const contextId = url.searchParams.get("context");
      const items = (payload[CLAIM.deepLinkingContentItems] ?? []) as { lineItem?: Omit<StoredLineItem, "id"> }[];
      for (const item of items) {
        if (!contextId || !item.lineItem) continue;
        const id = `${this.lineItemsUrl(contextId)}/${this.lineItems.size + 1}`;
        this.lineItems.set(id, { ...item.lineItem, id, resourceLinkId: `link-${randomUUID()}` });
      }
      return { status: 200, body: "<!doctype html><title>LMS</title><h1>Content added</h1>", type: "text/html" };
    }

    const lineItems = /^\/contexts\/([^/]+)\/lineitems$/.exec(url.pathname);
    if (lineItems) {
      if (!this.authorized(req, SCOPE.lineItem)) return json(401, { error: "unauthorized" });
      if (req.method === "POST") {
        const item = JSON.parse(await readBody(req)) as Omit<StoredLineItem, "id">;
        const id = `${this.url}${url.pathname}/${this.lineItems.size + 1}`;
        this.lineItems.set(id, { ...item, id });
        return json(201, { ...item, id });
      }
      const resourceId = url.searchParams.get("resource_id");
      const prefix = `${this.url}${url.pathname}/`;
      return json(
        200,
        [...this.lineItems.values()].filter(
          (i) => i.id.startsWith(prefix) && (!resourceId || i.resourceId === resourceId),
        ),
      );
    }

    const service = /^(\/contexts\/[^/]+\/lineitems\/\d+)\/(scores|results)$/.exec(url.pathname);
    if (service) {
      const lineItemId = `${this.url}${service[1]}`;
      if (!this.lineItems.has(lineItemId)) return json(404, { error: "no such line item" });
      if (service[2] === "scores" && req.method === "POST") {
        if (!this.authorized(req, SCOPE.score)) return json(401, { error: "unauthorized" });
        const score = JSON.parse(await readBody(req)) as { userId: string; scoreGiven: number; scoreMaximum: number };
        this.scores.push({ lineItemId, score });
        this.setResult(lineItemId, score.userId, score.scoreGiven, score.scoreMaximum);
        return { status: 200, body: "" };
      }
      if (!this.authorized(req, SCOPE.resultReadOnly)) return json(401, { error: "unauthorized" });
      return json(
        200,
        [...(this.results.get(lineItemId) ?? new Map()).entries()].map(([userId, r]) => ({
          id: `${lineItemId}/results/${userId}`,
          scoreOf: lineItemId,
          userId,
          ...r,
        })),
      );
    }

    if (/^\/contexts\/[^/]+\/memberships$/.test(url.pathname)) {
      if (!this.authorized(req, SCOPE.nrps)) return json(401, { error: "unauthorized" });
      const page = Number(url.searchParams.get("page") ?? "0");
      const members = this.members.slice(page * this.pageSize, (page + 1) * this.pageSize);
      const more = (page + 1) * this.pageSize < this.members.length;
      const next = new URL(url);
      next.searchParams.set("page", String(page + 1));
      return json(
        200,
        { id: url.toString(), context: { id: "ctx" }, members: members.map((m) => ({ status: "Active", ...m })) },
        more ? { link: `<${next}>; rel="next"` } : undefined,
      );
    }

    return { status: 404, body: "", type: "text/plain" };
  }
}
