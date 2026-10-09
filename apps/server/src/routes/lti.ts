import { randomBytes, createHash } from "node:crypto";
import {
  authRedirectUrl,
  loginRequestSchema,
  LtiError,
  peekIssuer,
  registerWithPlatform,
  toolEndpoints,
  toolJwks,
  verifyLaunch,
  type Platform,
} from "@hbe/lms";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { ApiDeps } from "../app.ts";
import { handleLaunch } from "../lti/launch.ts";
import { toolKeys } from "../lti/keys.ts";
import type { SignInService } from "../lti/sign-in.ts";

const STATE_TTL_MS = 10 * 60_000;
const COOKIE = "hbe_lti_state";
const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** A small page for the browser (launches are navigations, not API calls). */
function page(reply: FastifyReply, status: number, title: string, message: string, script = "") {
  return reply
    .code(status)
    .header("content-type", "text/html; charset=utf-8")
    .header("cache-control", "no-store")
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem;color:#1d2433}h1{font-size:1.25rem}</style></head>
<body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${script}</body></html>`,
    );
}

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

/**
 * The LTI 1.3 tool (§13.2): JWKS, OIDC login initiation, launch, and Dynamic Registration. These
 * are browser navigations from the LMS, so failures are pages, not JSON.
 */
export async function ltiRoutes(app: FastifyInstance, deps: ApiDeps & { signIn: SignInService }): Promise<void> {
  const { db, settings, signIn } = deps;
  const { APP_URL, API_URL } = settings.env;
  const endpoints = toolEndpoints(API_URL);
  const secure = API_URL.startsWith("https://");

  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  app.get("/.well-known/jwks.json", async (_req, reply) => {
    const keys = await toolKeys(settings);
    return reply.header("cache-control", "public, max-age=300").send(keys ? toolJwks(keys) : { keys: [] });
  });

  /** OIDC third-party login initiation (GET or POST, as the platform likes). */
  const login = async (params: unknown, reply: FastifyReply) => {
    const parsed = loginRequestSchema.safeParse(params);
    if (!parsed.success)
      return page(reply, 400, "Couldn't open the platform", "The LMS sent an incomplete login request.");
    const req = parsed.data;
    let query = db
      .selectFrom("lms_connections")
      .selectAll()
      .where("issuer", "=", req.iss.replace(/\/$/, ""))
      .where("status", "=", "active");
    if (req.client_id) query = query.where("client_id", "=", req.client_id);
    const conns = await query.execute();
    // Issuers are stored as given; accept a trailing slash difference.
    const matches = conns.length
      ? conns
      : await db
          .selectFrom("lms_connections")
          .selectAll()
          .where("issuer", "=", req.iss)
          .where("status", "=", "active")
          .$if(Boolean(req.client_id), (q) => q.where("client_id", "=", req.client_id!))
          .execute();
    if (matches.length !== 1) {
      return page(
        reply,
        400,
        "Couldn't open the platform",
        matches.length === 0
          ? "This LMS isn't connected to the platform. Ask your institution's admin to add it."
          : "The LMS didn't say which registration to use (client_id).",
      );
    }
    const conn = matches[0]!;
    const state = randomBytes(24).toString("base64url");
    const nonce = randomBytes(24).toString("base64url");
    await db.insertInto("lti_launch_states").values({ state, nonce, lms_connection_id: conn.id }).execute();
    // The cookie binds the launch to this browser when the LMS doesn't block it (third-party
    // contexts often do; the single-use state still protects the launch).
    reply.header(
      "set-cookie",
      `${COOKIE}=${state}; Path=/lti; Max-Age=600; HttpOnly; SameSite=None${secure ? "; Secure" : ""}`,
    );
    return reply.redirect(
      authRedirectUrl(platformOf(conn), req, { redirectUri: endpoints.launchUrl, state, nonce }),
      302,
    );
  };
  app.get("/lti/login", (req, reply) => login(req.query, reply));
  app.post("/lti/login", (req, reply) => login(req.body, reply));

  app.post("/lti/launch", async (req, reply) => {
    const body = z.object({ id_token: z.string().max(30_000), state: z.string().max(200) }).safeParse(req.body);
    if (!body.success) return page(reply, 400, "Couldn't open the platform", "The LMS sent an incomplete launch.");
    const consumed = await db
      .updateTable("lti_launch_states")
      .set({ consumed_at: new Date() })
      .where("state", "=", body.data.state)
      .where("consumed_at", "is", null)
      .where("created_at", ">", new Date(Date.now() - STATE_TTL_MS))
      .returning(["nonce", "lms_connection_id"])
      .executeTakeFirst();
    if (!consumed) {
      return page(reply, 400, "This link has expired", "Open the activity in your LMS again.");
    }
    const cookieState = /(?:^|;\s*)hbe_lti_state=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
    if (cookieState && cookieState !== body.data.state) {
      return page(reply, 400, "Couldn't open the platform", "This launch belongs to another browser session.");
    }
    const conn = await db
      .selectFrom("lms_connections")
      .selectAll()
      .where("id", "=", consumed.lms_connection_id)
      .where("status", "=", "active")
      .executeTakeFirst();
    if (!conn) return page(reply, 400, "Couldn't open the platform", "This LMS connection was turned off.");
    const { issuer } = peekIssuer(body.data.id_token);
    if (issuer !== conn.issuer)
      return page(reply, 400, "Couldn't open the platform", "The launch came from another LMS.");

    try {
      const launch = await verifyLaunch(body.data.id_token, platformOf(conn), { nonce: consumed.nonce });
      if (launch.messageType === "LtiDeepLinkingRequest") {
        return page(reply, 501, "Not available yet", "Adding platform assignments from the LMS is coming soon.");
      }
      const outcome = await handleLaunch(db, signIn, conn, launch);
      if (outcome.kind === "refused") return page(reply, 403, "Couldn't sign you in", outcome.message);
      if (outcome.kind === "pending") {
        return reply.redirect(`${APP_URL}/lti/pending?institution=${encodeURIComponent(outcome.institution)}`, 302);
      }
      const target = new URL("/auth/lti", APP_URL);
      target.searchParams.set("token_hash", outcome.tokenHash);
      target.searchParams.set("next", outcome.next);
      reply.header("set-cookie", `${COOKIE}=; Path=/lti; Max-Age=0`);
      // Inside the LMS's iframe the platform's session cookie would be third-party (and
      // blocked), so the platform opens in its own tab.
      if (req.headers["sec-fetch-dest"] === "iframe") {
        return page(
          reply,
          200,
          "Open HBE Projects",
          "HBE Projects opens in its own tab.",
          `<p><a id="continue" href="${escapeHtml(target.toString())}" target="_blank" rel="noopener">Open HBE Projects</a></p>`,
        );
      }
      return reply.redirect(target.toString(), 302);
    } catch (err) {
      if (err instanceof LtiError) {
        req.log.warn({ code: err.code, connection: conn.id }, "LTI launch refused");
        return page(reply, 400, "Couldn't open the platform", err.message);
      }
      throw err;
    }
  });

  /**
   * LTI Dynamic Registration: the LMS opens this URL (an admin's one-time invite) with its
   * configuration URL and a registration token; the tool registers itself and closes.
   */
  app.get("/lti/register", async (req, reply) => {
    const q = z
      .object({
        invite: z.string().min(20).max(100),
        openid_configuration: z.string().url(),
        registration_token: z.string().max(4000).optional(),
      })
      .safeParse(req.query);
    if (!q.success) return page(reply, 400, "Registration failed", "This registration link is incomplete.");
    if (settings.env.HBE_ENV !== "local" && !q.data.openid_configuration.startsWith("https://")) {
      return page(reply, 400, "Registration failed", "The LMS configuration must be served over HTTPS.");
    }
    const invite = await db
      .selectFrom("lti_registration_invites")
      .selectAll()
      .where("token_hash", "=", hashToken(q.data.invite))
      .where("used_at", "is", null)
      .where("expires_at", ">", new Date())
      .executeTakeFirst();
    if (!invite) {
      return page(
        reply,
        400,
        "Registration failed",
        "This registration link has expired or was already used. Create a new one.",
      );
    }
    try {
      const reg = await registerWithPlatform(q.data.openid_configuration, q.data.registration_token ?? null, {
        name: "HBE Projects",
        description: "Full-stack project evaluation: repositories, automated tests and grades.",
        apiUrl: API_URL,
      });
      const conn = await db
        .insertInto("lms_connections")
        .values({
          institution_id: invite.institution_id,
          type: invite.type,
          name: invite.name,
          issuer: reg.issuer.replace(/\/$/, ""),
          client_id: reg.clientId,
          deployment_ids: reg.deploymentId ? [reg.deploymentId] : [],
          auth_login_url: reg.authLoginUrl,
          auth_token_url: reg.authTokenUrl,
          jwks_url: reg.jwksUrl,
          registration: JSON.stringify({ productFamily: reg.productFamily, response: reg.response }),
          registered_by: "dynamic",
          created_by: invite.created_by,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await db
        .updateTable("lti_registration_invites")
        .set({ used_at: new Date(), lms_connection_id: conn.id })
        .where("id", "=", invite.id)
        .execute();
      return page(
        reply,
        200,
        "Registered",
        `${invite.name} is connected to HBE Projects. You can close this window.`,
        `<script>(window.opener || window.parent).postMessage({ subject: "org.imsglobal.lti.close" }, "*");</script>`,
      );
    } catch (err) {
      const message = err instanceof LtiError ? err.message : "The LMS could not be reached.";
      if ((err as { code?: string }).code === "23505") {
        return page(reply, 409, "Already registered", "This LMS registration is already connected.");
      }
      req.log.warn({ err: (err as Error).message }, "LTI dynamic registration failed");
      return page(reply, 400, "Registration failed", message);
    }
  });
}
