import { authorize } from "@hbe/core";
import { withActor } from "@hbe/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiDeps } from "../app.ts";
import { authenticate } from "../auth.ts";
import { conflict, notFound } from "../errors.ts";
import { SsoAdminError, type SsoAdmin } from "../sso-admin.ts";

const uuid = z.string().uuid();
const domain = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, "Domains look like uni.edu.sg");
/** Domains everyone can get an address at: no institution owns them. */
const PUBLIC_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "proton.me",
  "protonmail.com",
  "aol.com",
  "gmx.com",
  "qq.com",
  "163.com",
]);

/**
 * Single sign-on (SAML through Supabase Auth). The institution's admins ask for it; the platform
 * operator turns it on after checking the institution owns the domains (an IdP can assert any
 * address in them), which registers the IdP with Supabase Auth; either can turn it off.
 */
export async function ssoRoutes(app: FastifyInstance, deps: ApiDeps & { ssoAdmin: SsoAdmin }): Promise<void> {
  const { db, verifier, settings, ssoAdmin } = deps;
  const available = () => {
    if (!settings.profile.features.saml_sso) {
      throw conflict("sso_unavailable", "Single sign-on is part of the paid plan (it needs Supabase Pro).");
    }
  };

  app.put<{ Params: { institutionId: string } }>("/v1/institutions/:institutionId/sso", async (req) => {
    const actor = await authenticate(req, db, verifier);
    const institutionId = uuid.parse(req.params.institutionId);
    authorize(actor, "manageInstitution", institutionId);
    available();
    const body = z
      .object({
        metadataUrl: z.string().trim().url().startsWith("https://", "The metadata URL must use https").optional(),
        metadataXml: z
          .string()
          .trim()
          .min(100)
          .max(100_000)
          .includes("EntityDescriptor", { message: "Not SAML metadata" })
          .optional(),
        domains: z.array(domain).min(1).max(10),
        joinAsStudent: z.boolean().default(false),
      })
      .strict()
      .refine(
        (b) => Boolean(b.metadataUrl) !== Boolean(b.metadataXml),
        "Give the metadata URL or the metadata file, not both",
      )
      .parse(req.body);
    const domains = [...new Set(body.domains)];
    const shared = domains.find((d) => PUBLIC_DOMAINS.has(d));
    if (shared)
      throw conflict("public_domain", `${shared} is an email provider anyone can use, not your institution's.`);
    const taken = await db
      .selectFrom("sso_connections")
      .select("domains")
      .where("institution_id", "!=", institutionId)
      .where("status", "in", ["pending", "active"])
      .execute();
    const clash = domains.find((d) => taken.some((t) => t.domains.includes(d)));
    if (clash) throw conflict("domain_taken", `${clash} is another institution's.`);

    const existing = await db
      .selectFrom("sso_connections")
      .select(["id", "status"])
      .where("institution_id", "=", institutionId)
      .executeTakeFirst();
    if (existing?.status === "active") {
      // Only how people join can change on a live connection; a new IdP or domains need a new review.
      throw conflict(
        "sso_active",
        "Single sign-on is on. Turn it off before changing the identity provider or domains.",
      );
    }
    const values = {
      domains,
      metadata_url: body.metadataUrl ?? null,
      metadata_xml: body.metadataXml ?? null,
      join_as_student: body.joinAsStudent,
      status: "pending" as const,
      requested_by: actor.userId,
      reviewed_by: null,
      reviewed_at: null,
      review_note: null,
    };
    const row = await withActor(db, actor.userId, (tx) =>
      existing
        ? tx
            .updateTable("sso_connections")
            .set(values)
            .where("id", "=", existing.id)
            .returning(["id", "status"])
            .executeTakeFirstOrThrow()
        : tx
            .insertInto("sso_connections")
            .values({ institution_id: institutionId, ...values })
            .returning(["id", "status"])
            .executeTakeFirstOrThrow(),
    );
    return row;
  });

  /** The operator turns it on (registering the IdP) or declines, with a note for the admins. */
  app.post<{ Params: { connectionId: string } }>("/v1/platform/sso/:connectionId/review", async (req) => {
    const actor = await authenticate(req, db, verifier);
    authorize(actor, "listAllInstitutions");
    available();
    const body = z
      .object({ decision: z.enum(["approve", "reject"]), note: z.string().trim().max(500).optional() })
      .strict()
      .parse(req.body);
    const conn = await db
      .selectFrom("sso_connections")
      .selectAll()
      .where("id", "=", uuid.parse(req.params.connectionId))
      .executeTakeFirst();
    if (!conn) throw notFound("Single sign-on request not found");
    if (conn.status !== "pending") throw conflict("not_pending", "That request was already decided.");
    const reviewed = { reviewed_by: actor.userId, reviewed_at: new Date(), review_note: body.note || null };
    if (body.decision === "reject") {
      await withActor(db, actor.userId, (tx) =>
        tx
          .updateTable("sso_connections")
          .set({ status: "rejected", ...reviewed })
          .where("id", "=", conn.id)
          .execute(),
      );
      return { status: "rejected" };
    }
    let providerId = conn.supabase_provider_id;
    try {
      if (providerId) await ssoAdmin.setDisabled(providerId, false);
      else {
        providerId = await ssoAdmin.createProvider({
          metadataUrl: conn.metadata_url ?? undefined,
          metadataXml: conn.metadata_xml ?? undefined,
          domains: conn.domains,
        });
      }
    } catch (err) {
      if (err instanceof SsoAdminError)
        throw conflict("idp_refused", `Supabase Auth refused the identity provider: ${err.message}`);
      throw err;
    }
    await withActor(db, actor.userId, (tx) =>
      tx
        .updateTable("sso_connections")
        .set({ status: "active", supabase_provider_id: providerId, ...reviewed })
        .where("id", "=", conn.id)
        .execute(),
    );
    return { status: "active" };
  });

  /** The institution's admins (or the operator) turn single sign-on off; it can be asked for again. */
  app.post<{ Params: { institutionId: string } }>("/v1/institutions/:institutionId/sso/disable", async (req) => {
    const actor = await authenticate(req, db, verifier);
    const institutionId = uuid.parse(req.params.institutionId);
    if (!actor.isSuperAdmin) authorize(actor, "manageInstitution", institutionId);
    const conn = await db
      .selectFrom("sso_connections")
      .select(["id", "status", "supabase_provider_id"])
      .where("institution_id", "=", institutionId)
      .executeTakeFirst();
    if (!conn) throw notFound("Single sign-on isn't set up");
    if (conn.status === "disabled") return { status: "disabled" };
    if (conn.supabase_provider_id) await ssoAdmin.setDisabled(conn.supabase_provider_id, true);
    await withActor(db, actor.userId, (tx) =>
      tx.updateTable("sso_connections").set({ status: "disabled" }).where("id", "=", conn.id).execute(),
    );
    return { status: "disabled" };
  });

  /** Whether people joining through the IdP become students (changeable while it's on). */
  app.patch<{ Params: { institutionId: string } }>("/v1/institutions/:institutionId/sso", async (req) => {
    const actor = await authenticate(req, db, verifier);
    const institutionId = uuid.parse(req.params.institutionId);
    authorize(actor, "manageInstitution", institutionId);
    const { joinAsStudent } = z.object({ joinAsStudent: z.boolean() }).strict().parse(req.body);
    const updated = await withActor(db, actor.userId, (tx) =>
      tx
        .updateTable("sso_connections")
        .set({ join_as_student: joinAsStudent })
        .where("institution_id", "=", institutionId)
        .returning("id")
        .executeTakeFirst(),
    );
    if (!updated) throw notFound("Single sign-on isn't set up");
    return { joinAsStudent };
  });
}
