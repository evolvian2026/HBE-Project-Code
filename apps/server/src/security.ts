import { createHash } from "node:crypto";
import type { Settings } from "@hbe/settings";
import type { FastifyInstance, FastifyRequest } from "fastify";

/**
 * Response headers for everything the API answers (the web app's pages get theirs from Next).
 * LTI pages are shown inside the LMS, so only they may be framed.
 */
export function securityHeaders(app: FastifyInstance, settings: Settings): void {
  const https = settings.env.API_URL.startsWith("https://");
  app.addHook("onSend", async (req, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "strict-origin-when-cross-origin");
    if (https) reply.header("strict-transport-security", "max-age=31536000");
    const framed = req.url.startsWith("/lti/");
    if (!framed) reply.header("x-frame-options", "DENY");
    if (String(reply.getHeader("content-type") ?? "").startsWith("application/json")) {
      reply.header("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
    }
    // API answers are for one person: never kept by browsers or shared caches.
    if (req.url.startsWith("/v1/") && !reply.hasHeader("cache-control")) reply.header("cache-control", "no-store");
  });
}

export interface RateLimit {
  /** Requests allowed per window. */
  max: number;
  windowMs: number;
  /** Who the limit is for; null to not limit the request. */
  key(req: FastifyRequest): string | null;
}

const hash = (s: string) => createHash("sha256").update(s).digest("base64url").slice(0, 22);

/**
 * The API's rate limits, per process (each api instance counts its own requests). Signed-in
 * requests are counted per credential: the web app calls the API for everyone from its own
 * address, and a campus's students often share one. Public LTI endpoints are counted per
 * address. GitHub webhooks are signed and not limited.
 */
export function defaultRateLimits(): Record<string, RateLimit> {
  return {
    api: {
      max: 600,
      windowMs: 60_000,
      key: (req) => {
        if (!req.url.startsWith("/v1/")) return null;
        const auth = req.headers.authorization;
        return auth ? `api:${hash(auth)}` : `api-ip:${req.ip}`;
      },
    },
    lti: {
      max: 600,
      windowMs: 60_000,
      key: (req) => (req.url.startsWith("/lti/") ? `lti:${req.ip}` : null),
    },
  };
}

/** Fixed-window counters: answers 429 with Retry-After once a key is over its limit. */
export function rateLimit(app: FastifyInstance, limits: Record<string, RateLimit>): void {
  const windows = new Map<string, { resetAt: number; count: number }>();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, w] of windows) if (w.resetAt <= now) windows.delete(key);
  }, 60_000);
  sweep.unref();
  app.addHook("onClose", async () => clearInterval(sweep));

  app.addHook("onRequest", async (req, reply) => {
    const now = Date.now();
    for (const [name, limit] of Object.entries(limits)) {
      const who = limit.key(req);
      if (!who) continue;
      const key = `${name}|${who}`;
      let w = windows.get(key);
      if (!w || w.resetAt <= now) {
        w = { resetAt: now + limit.windowMs, count: 0 };
        windows.set(key, w);
      }
      w.count += 1;
      if (w.count > limit.max) {
        const retryAfter = Math.ceil((w.resetAt - now) / 1000);
        req.log.warn({ limit: name }, "rate limited");
        return reply
          .code(429)
          .header("retry-after", String(retryAfter))
          .send({ error: "rate_limited", message: `Too many requests. Try again in ${retryAfter} seconds.` });
      }
    }
  });
}

/** Query parameters that are credentials or one-time codes, never logged. */
const SECRET_PARAMS = ["code", "state", "token", "invite", "registration_token", "id_token", "access_token", "key"];

/** The request URL with secret query parameters replaced, for logs. */
export function redactUrl(url: string): string {
  const q = url.indexOf("?");
  if (q === -1) return url;
  const params = new URLSearchParams(url.slice(q + 1));
  let changed = false;
  for (const name of SECRET_PARAMS) {
    if (params.has(name)) {
      params.set(name, "[redacted]");
      changed = true;
    }
  }
  return changed ? `${url.slice(0, q)}?${params.toString()}` : url;
}
