import { createHash, randomBytes } from "node:crypto";
import {
  authorize,
  classifyHost,
  customDomainProblem,
  domainVerificationRecord,
  institutionBaseUrl,
  normalizeHostname,
} from "@hbe/core";
import { withActor } from "@hbe/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiDeps } from "../app.ts";
import { authenticate } from "../auth.ts";
import { addressConfig, checkDomain, type DomainProvisioner, type TxtResolver } from "../domains.ts";
import { badRequest, conflict, notFound } from "../errors.ts";
import type { SignInService } from "../lti/sign-in.ts";

const uuid = z.string().uuid();
const HANDOFF_SECONDS = 60;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Institution addresses (Phase 3E): the institution's subdomain and vanity domain, the host
 * lookup the web app uses to serve them, and the one-time handoff that signs someone in there.
 */
export async function domainRoutes(
  app: FastifyInstance,
  deps: ApiDeps & { provisioner: DomainProvisioner; resolveTxt: TxtResolver; signIn: SignInService },
): Promise<void> {
  const { db, verifier, settings, provisioner, resolveTxt, signIn } = deps;
  const cfg = addressConfig(settings);
  const target = settings.env.CUSTOM_DOMAIN_TARGET ?? new URL(settings.env.APP_URL).hostname;

  const view = (d: { [k: string]: unknown; hostname: string; verification_token: string } | undefined) =>
    d
      ? {
          id: d.id,
          hostname: d.hostname,
          url: institutionBaseUrl(cfg, { slug: "", customDomain: d.hostname }),
          status: d.status,
          error: d.error,
          lastCheckedAt: d.last_checked_at,
          activatedAt: d.activated_at,
          record: domainVerificationRecord(d.hostname, d.verification_token),
        }
      : null;

  /** The slug of the institution a host serves: a live vanity domain, or an existing institution's subdomain. */
  async function slugForHost(host: string): Promise<string | null> {
    const kind = classifyHost(host, cfg);
    if (kind.kind === "subdomain") {
      const inst = await db
        .selectFrom("institutions")
        .select("slug")
        .where("slug", "=", kind.slug)
        .where("status", "!=", "purged")
        .executeTakeFirst();
      return inst?.slug ?? null;
    }
    if (kind.kind === "custom") {
      const row = await db
        .selectFrom("institution_domains as d")
        .innerJoin("institutions as i", "i.id", "d.institution_id")
        .select("i.slug")
        .where("d.hostname", "=", kind.hostname)
        .where("d.status", "=", "active")
        .executeTakeFirst();
      return row?.slug ?? null;
    }
    return null;
  }

  const domainOf = (institutionId: string) =>
    db.selectFrom("institution_domains").selectAll().where("institution_id", "=", institutionId).executeTakeFirst();

  /** The institution's addresses, and its vanity domain with the DNS records to set. */
  app.get<{ Params: { institutionId: string } }>("/v1/institutions/:institutionId/address", async (req) => {
    const actor = await authenticate(req, db, verifier);
    const institutionId = uuid.parse(req.params.institutionId);
    authorize(actor, "manageInstitution", institutionId);
    const inst = await db
      .selectFrom("institutions")
      .select("slug")
      .where("id", "=", institutionId)
      .executeTakeFirstOrThrow();
    const domain = await domainOf(institutionId);
    return {
      platformUrl: `${new URL(settings.env.APP_URL).origin}/i/${inst.slug}`,
      subdomainUrl: cfg.baseDomain ? institutionBaseUrl(cfg, { slug: inst.slug }) : null,
      domain: view(domain),
      target,
      provisioner: provisioner.mode,
    };
  });

  app.put<{ Params: { institutionId: string } }>("/v1/institutions/:institutionId/domain", async (req, reply) => {
    const actor = await authenticate(req, db, verifier);
    const institutionId = uuid.parse(req.params.institutionId);
    authorize(actor, "manageInstitution", institutionId);
    const { hostname: typed } = z
      .object({ hostname: z.string().max(300) })
      .strict()
      .parse(req.body);
    const hostname = normalizeHostname(typed);
    if (!hostname) throw badRequest("invalid_hostname", "Enter a domain such as projects.example.edu.");
    const problem = customDomainProblem(hostname, cfg);
    if (problem) throw conflict("not_allowed", problem);
    if (await domainOf(institutionId)) {
      throw conflict("domain_exists", "Remove the current domain first: an institution has one.");
    }
    const taken = await db
      .selectFrom("institution_domains")
      .select("id")
      .where("hostname", "=", hostname)
      .executeTakeFirst();
    if (taken) throw conflict("domain_taken", "Another institution has already added this domain.");
    const row = await withActor(db, actor.userId, (tx) =>
      tx
        .insertInto("institution_domains")
        .values({
          institution_id: institutionId,
          hostname,
          verification_token: randomBytes(24).toString("base64url"),
          created_by: actor.userId,
        })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
    return reply.code(201).send({ domain: view(row) });
  });

  /** Checks the TXT record now (the worker also checks every few minutes). */
  app.post<{ Params: { institutionId: string } }>("/v1/institutions/:institutionId/domain/check", async (req) => {
    const actor = await authenticate(req, db, verifier);
    const institutionId = uuid.parse(req.params.institutionId);
    authorize(actor, "manageInstitution", institutionId);
    const domain = await domainOf(institutionId);
    if (!domain) throw notFound("No domain to check");
    return { domain: view(await checkDomain({ db, provisioner, resolveTxt }, domain.id)) };
  });

  app.delete<{ Params: { institutionId: string } }>("/v1/institutions/:institutionId/domain", async (req, reply) => {
    const actor = await authenticate(req, db, verifier);
    const institutionId = uuid.parse(req.params.institutionId);
    if (!actor.isSuperAdmin) authorize(actor, "manageInstitution", institutionId);
    const domain = await domainOf(institutionId);
    if (!domain) throw notFound("No domain to remove");
    if (domain.status !== "pending") await provisioner.remove(domain.hostname, domain.provider_id);
    await withActor(db, actor.userId, (tx) =>
      tx.deleteFrom("institution_domains").where("id", "=", domain.id).execute(),
    );
    return reply.code(204).send();
  });

  /** The platform operator: every vanity domain, to add to the hosting by hand when manual. */
  app.get("/v1/platform/domains", async (req) => {
    const actor = await authenticate(req, db, verifier);
    authorize(actor, "listAllInstitutions");
    const rows = await db
      .selectFrom("institution_domains as d")
      .innerJoin("institutions as i", "i.id", "d.institution_id")
      .select(["d.id", "d.hostname", "d.status", "d.error", "d.verified_at", "d.activated_at", "i.name", "i.slug"])
      .orderBy("d.created_at", "desc")
      .execute();
    return { provisioner: provisioner.mode, target, domains: rows };
  });

  app.post<{ Params: { domainId: string } }>("/v1/platform/domains/:domainId/live", async (req) => {
    const actor = await authenticate(req, db, verifier);
    authorize(actor, "listAllInstitutions");
    if (provisioner.mode !== "manual") {
      throw conflict("automatic", "Domains are added to the hosting automatically; they go live by themselves.");
    }
    const row = await withActor(db, actor.userId, (tx) =>
      tx
        .updateTable("institution_domains")
        .set({ status: "active", activated_at: new Date(), error: null })
        .where("id", "=", uuid.parse(req.params.domainId))
        .where("status", "=", "provisioning")
        .returning(["id", "status"])
        .executeTakeFirst(),
    );
    if (!row) throw conflict("not_ready", "Only a domain whose ownership is proven can go live.");
    return row;
  });

  /**
   * Which institution a host serves (the web app asks, then caches): a live vanity domain, or
   * a subdomain of an institution that exists. Public: it reveals no more than visiting does.
   */
  app.get<{ Params: { host: string } }>("/v1/hosts/:host", async (req) => {
    const slug = await slugForHost(req.params.host);
    if (!slug) throw notFound("No institution at this address");
    return { slug };
  });

  /**
   * Sign-in happens on the platform's address; this hands the signed-in person to an
   * institution's address with a one-time code, valid for a minute, for that host only.
   */
  app.post("/v1/auth/handoffs", async (req) => {
    const actor = await authenticate(req, db, verifier);
    const { to } = z.object({ to: z.string().url() }).strict().parse(req.body);
    const url = new URL(to);
    if (url.protocol !== new URL(settings.env.APP_URL).protocol || !(await slugForHost(url.host))) {
      throw badRequest("invalid_host", "That isn't an institution's address.");
    }
    const code = randomBytes(32).toString("base64url");
    await db
      .insertInto("session_handoffs")
      .values({
        code_hash: sha256(code),
        user_id: actor.userId,
        host: url.host.toLowerCase(),
        expires_at: new Date(Date.now() + HANDOFF_SECONDS * 1000),
      })
      .execute();
    const target = new URL("/auth/handoff", url.origin);
    target.searchParams.set("code", code);
    target.searchParams.set("next", `${url.pathname}${url.search}` || "/");
    return { url: target.toString() };
  });

  /** The institution's address redeems the code for a sign-in token (once). */
  app.post("/v1/auth/handoffs/redeem", async (req) => {
    const { code, host } = z
      .object({ code: z.string().min(20).max(100), host: z.string().min(1).max(260) })
      .strict()
      .parse(req.body);
    const used = await db
      .updateTable("session_handoffs")
      .set({ used_at: new Date() })
      .where("code_hash", "=", sha256(code))
      .where("host", "=", host.toLowerCase())
      .where("used_at", "is", null)
      .where("expires_at", ">", new Date())
      .returning("user_id")
      .executeTakeFirst();
    if (!used) throw badRequest("invalid_code", "The sign-in link has expired or was already used.");
    const profile = await db.selectFrom("profiles").select("email").where("id", "=", used.user_id).executeTakeFirst();
    if (!profile?.email) throw badRequest("invalid_code", "This account can't be signed in here.");
    return { tokenHash: await signIn.signInToken(profile.email) };
  });
}
