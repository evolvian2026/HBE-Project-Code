import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { LtiError } from "./errors.ts";
import type { ToolKey } from "./keys.ts";
import type { Platform } from "./platform.ts";

/** An AGS line item: a gradebook column. */
export interface LineItem {
  id: string;
  label: string;
  scoreMaximum: number;
  resourceId?: string;
  resourceLinkId?: string;
  tag?: string;
}

/** An AGS score the tool posts for a learner. */
export interface Score {
  userId: string;
  scoreGiven: number;
  scoreMaximum: number;
  comment?: string;
  timestamp: string;
  activityProgress: "Completed";
  gradingProgress: "FullyGraded";
}

/** What the LMS's gradebook holds for a learner (which a teacher may have edited there). */
export interface Result {
  userId: string;
  resultScore: number | null;
  resultMaximum: number | null;
}

/** An NRPS course member. */
export interface Member {
  userId: string;
  status: string;
  roles: string[];
  email: string | null;
  name: string | null;
}

const MEDIA = {
  lineItem: "application/vnd.ims.lis.v2.lineitem+json",
  lineItems: "application/vnd.ims.lis.v2.lineitemcontainer+json",
  score: "application/vnd.ims.lis.v1.score+json",
  results: "application/vnd.ims.lis.v2.resultcontainer+json",
  members: "application/vnd.ims.lti-nrps.v2.membershipcontainer+json",
} as const;

const SCOPES = {
  lineItem: "https://purl.imsglobal.org/spec/lti-ags/scope/lineitem",
  score: "https://purl.imsglobal.org/spec/lti-ags/scope/score",
  results: "https://purl.imsglobal.org/spec/lti-ags/scope/result.readonly",
  members: "https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly",
} as const;

const MAX_PAGES = 100;

/** `/scores` or `/results` appended to a line item URL's path (before its query string). */
export function serviceUrl(lineItemUrl: string, suffix: "/scores" | "/results"): string {
  const url = new URL(lineItemUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}${suffix}`;
  return url.toString();
}

const nextPage = (res: Response) => /<([^>]+)>\s*;\s*rel="next"/.exec(res.headers.get("link") ?? "")?.[1] ?? null;
const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : null);

/**
 * Calls a platform's LTI Advantage services (AGS and NRPS) as the tool. Access tokens come from
 * the platform's token endpoint with a client assertion signed by the tool's key (LTI Security
 * Framework §4.1) and are reused until shortly before they expire.
 */
export class LtiServices {
  private readonly tokens = new Map<string, { token: string; expiresAt: number }>();

  constructor(
    private readonly platform: Platform,
    private readonly key: ToolKey,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async token(scopes: readonly string[]): Promise<string> {
    const scope = [...scopes].sort().join(" ");
    const cached = this.tokens.get(scope);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    const assertion = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: this.key.kid, typ: "JWT" })
      .setIssuer(this.platform.clientId)
      .setSubject(this.platform.clientId)
      .setAudience(this.platform.authTokenUrl)
      .setIssuedAt()
      .setExpirationTime("5m")
      .setJti(randomUUID())
      .sign(this.key.privateKey);
    const res = await this.fetchImpl(this.platform.authTokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: assertion,
        scope,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => null)) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
    } | null;
    if (!res.ok || typeof body?.access_token !== "string") {
      throw new LtiError(
        "token_failed",
        `The LMS refused an access token (HTTP ${res.status}${body?.error ? `, ${body.error}` : ""}).`,
      );
    }
    this.tokens.set(scope, {
      token: body.access_token,
      expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000,
    });
    return body.access_token;
  }

  private async call(
    url: string,
    scopes: readonly string[],
    init: { method?: "GET" | "POST"; accept: string; contentType?: string; body?: unknown },
  ): Promise<Response> {
    const method = init.method ?? "GET";
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${await this.token(scopes)}`,
        accept: init.accept,
        ...(init.contentType ? { "content-type": init.contentType } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      throw new LtiError(
        "service_failed",
        `The LMS answered HTTP ${res.status} to ${method} ${url}${detail ? `: ${detail}` : ""}`,
      );
    }
    return res;
  }

  /** The line item the tool made for a resource (its `resourceId`), if any. */
  async findLineItem(lineItemsUrl: string, resourceId: string): Promise<LineItem | null> {
    const url = new URL(lineItemsUrl);
    url.searchParams.set("resource_id", resourceId);
    const res = await this.call(url.toString(), [SCOPES.lineItem], { accept: MEDIA.lineItems });
    const items = (await res.json()) as LineItem[];
    return (Array.isArray(items) ? items : []).find((i) => i.resourceId === resourceId) ?? null;
  }

  async createLineItem(lineItemsUrl: string, item: Omit<LineItem, "id">): Promise<LineItem> {
    const res = await this.call(lineItemsUrl, [SCOPES.lineItem], {
      method: "POST",
      accept: MEDIA.lineItem,
      contentType: MEDIA.lineItem,
      body: item,
    });
    const created = (await res.json()) as LineItem;
    if (!str(created?.id)) throw new LtiError("service_failed", "The LMS didn't return the new line item.");
    return created;
  }

  async postScore(lineItemUrl: string, score: Score): Promise<void> {
    await this.call(serviceUrl(lineItemUrl, "/scores"), [SCOPES.score], {
      method: "POST",
      accept: "application/json",
      contentType: MEDIA.score,
      body: score,
    });
  }

  /** Every result of a line item (following pagination). */
  async results(lineItemUrl: string): Promise<Result[]> {
    const out: Result[] = [];
    let url: string | null = serviceUrl(lineItemUrl, "/results");
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const res = await this.call(url, [SCOPES.results], { accept: MEDIA.results });
      for (const r of (await res.json()) as Record<string, unknown>[]) {
        const userId = str(r.userId);
        if (!userId) continue;
        out.push({
          userId,
          resultScore: typeof r.resultScore === "number" ? r.resultScore : null,
          resultMaximum: typeof r.resultMaximum === "number" ? r.resultMaximum : null,
        });
      }
      url = nextPage(res);
    }
    return out;
  }

  /** The course roster (NRPS, following pagination). */
  async members(membershipsUrl: string): Promise<Member[]> {
    const out: Member[] = [];
    let url: string | null = membershipsUrl;
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const res = await this.call(url, [SCOPES.members], { accept: MEDIA.members });
      const body = (await res.json()) as { members?: Record<string, unknown>[] };
      for (const m of body.members ?? []) {
        const userId = str(m.user_id);
        if (!userId) continue;
        out.push({
          userId,
          status: str(m.status) ?? "Active",
          roles: Array.isArray(m.roles) ? (m.roles.filter((r) => typeof r === "string") as string[]) : [],
          email: str(m.email)?.toLowerCase() ?? null,
          name: str(m.name) ?? ([str(m.given_name), str(m.family_name)].filter(Boolean).join(" ") || null),
        });
      }
      url = nextPage(res);
    }
    return out;
  }
}
