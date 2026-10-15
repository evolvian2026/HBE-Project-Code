import { resolveTxt } from "node:dns/promises";
import { domainVerificationRecord, institutionBaseUrl, type AddressConfig } from "@hbe/core";
import type { Db } from "@hbe/db";
import type { Settings } from "@hbe/settings";

/**
 * Institution vanity domains (Phase 3E): ownership is proven with a DNS TXT record, then the
 * hosting is told to serve the domain (certificate and routing) by a provisioner.
 */

/** TXT records at a name (each record's strings); none when it doesn't exist. */
export type TxtResolver = (name: string) => Promise<string[][]>;

export const dnsTxt: TxtResolver = async (name) => {
  try {
    return await resolveTxt(name);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOTFOUND" || code === "ENODATA" || code === "NXDOMAIN") return [];
    throw err;
  }
};

/** Adds verified domains to the hosting and reports when they are served. */
export interface DomainProvisioner {
  /** Who adds the domain: the platform, through the hosting's API, or its operator by hand. */
  readonly mode: "render" | "manual";
  add(hostname: string): Promise<{ providerId: string | null }>;
  /** Whether the hosting serves it yet (certificate issued). Manual: the operator says so. */
  status(hostname: string, providerId: string | null): Promise<"provisioning" | "active" | { failed: string }>;
  remove(hostname: string, providerId: string | null): Promise<void>;
}

/** The platform operator adds the domain to the hosting and marks it live in the console. */
export const manualProvisioner: DomainProvisioner = {
  mode: "manual",
  async add() {
    return { providerId: null };
  },
  async status() {
    return "provisioning";
  },
  async remove() {},
};

/** Render's custom domains API (https://api-docs.render.com): Render issues the certificate. */
export function renderProvisioner(settings: Settings, fetchImpl: typeof fetch = fetch): DomainProvisioner {
  const service = settings.env.RENDER_SERVICE_ID ?? "";
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetchImpl(`https://api.render.com/v1/services/${encodeURIComponent(service)}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${settings.env.RENDER_API_KEY ?? ""}`,
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as unknown) : null;
    return { status: res.status, json };
  };
  type RenderDomain = { id: string; name: string; verificationStatus?: string };
  return {
    mode: "render",
    async add(hostname) {
      const r = await call("POST", "/custom-domains", { name: hostname });
      if (r.status === 409) {
        // Already added (e.g. a retry): look it up.
        const found = await call("GET", `/custom-domains/${encodeURIComponent(hostname)}`);
        return { providerId: (found.json as RenderDomain | null)?.id ?? null };
      }
      if (r.status >= 300) throw new Error(`Render refused the domain (HTTP ${r.status}): ${JSON.stringify(r.json)}`);
      const list = (Array.isArray(r.json) ? r.json : [r.json]) as RenderDomain[];
      return { providerId: list.find((d) => d?.name === hostname)?.id ?? list[0]?.id ?? null };
    },
    async status(hostname, providerId) {
      const r = await call("GET", `/custom-domains/${encodeURIComponent(providerId ?? hostname)}`);
      if (r.status === 404) return { failed: "Render no longer has this domain. Remove it and add it again." };
      if (r.status >= 300) throw new Error(`Render: HTTP ${r.status}`);
      if ((r.json as RenderDomain).verificationStatus === "verified") return "active";
      // Ask Render to check the DNS again; it issues the certificate once the CNAME points at it.
      await call("POST", `/custom-domains/${encodeURIComponent(providerId ?? hostname)}/verify`);
      return "provisioning";
    },
    async remove(hostname, providerId) {
      const r = await call("DELETE", `/custom-domains/${encodeURIComponent(providerId ?? hostname)}`);
      if (r.status >= 300 && r.status !== 404) throw new Error(`Render: HTTP ${r.status}`);
    },
  };
}

export function domainProvisioner(settings: Settings): DomainProvisioner {
  return settings.env.DOMAIN_PROVISIONER === "render" ? renderProvisioner(settings) : manualProvisioner;
}

export const addressConfig = (settings: Settings): AddressConfig => ({
  appUrl: settings.env.APP_URL,
  baseDomain: settings.env.INSTITUTION_BASE_DOMAIN ?? null,
  platformHosts: [new URL(settings.env.API_URL).hostname],
});

/** Whether the domain's TXT record carries the token. */
export async function hasVerificationRecord(resolve: TxtResolver, hostname: string, token: string): Promise<boolean> {
  const { name, value } = domainVerificationRecord(hostname, token);
  const records = await resolve(name);
  return records.some((parts) => parts.join("").trim() === value);
}

/**
 * The address of each institution's pages (for links in emails, GitHub checks and LMS
 * gradebooks): its live vanity domain, else its subdomain, else the platform's. Each
 * institution is looked up once per instance: make one per job, so changes show up.
 */
export function institutionAddresses(db: Db, settings: Settings) {
  const cfg = addressConfig(settings);
  const cache = new Map<string, Promise<string>>();
  const lookup = (column: "i.slug" | "i.id", value: string) => {
    const key = `${column}:${value}`;
    if (!cache.has(key)) {
      cache.set(
        key,
        db
          .selectFrom("institutions as i")
          .leftJoin("institution_domains as d", (j) =>
            j.onRef("d.institution_id", "=", "i.id").on("d.status", "=", "active"),
          )
          .select(["i.slug", "d.hostname"])
          .where(column, "=", value)
          .executeTakeFirst()
          .then((row) =>
            row ? institutionBaseUrl(cfg, { slug: row.slug, customDomain: row.hostname }) : new URL(cfg.appUrl).origin,
          ),
      );
    }
    return cache.get(key)!;
  };
  return {
    forSlug: (slug: string) => lookup("i.slug", slug),
    forId: (institutionId: string) => lookup("i.id", institutionId),
  };
}

export interface DomainDeps {
  db: Db;
  provisioner: DomainProvisioner;
  resolveTxt: TxtResolver;
}

/**
 * Moves a domain on: a pending one is checked for its TXT record (then handed to the
 * provisioner), a provisioning or failed one is checked with the hosting. Returns its row.
 */
export async function checkDomain({ db, provisioner, resolveTxt }: DomainDeps, domainId: string) {
  const d = await db.selectFrom("institution_domains").selectAll().where("id", "=", domainId).executeTakeFirstOrThrow();
  const now = new Date();
  const save = (fields: Record<string, unknown>) =>
    db
      .updateTable("institution_domains")
      .set({ last_checked_at: now, ...fields })
      .where("id", "=", domainId)
      .returningAll()
      .executeTakeFirstOrThrow();

  if (d.status === "active") return save({});
  if (d.status === "pending") {
    let found: boolean;
    try {
      found = await hasVerificationRecord(resolveTxt, d.hostname, d.verification_token);
    } catch (err) {
      return save({ error: `The DNS lookup failed (${(err as Error).message}). Try again in a few minutes.` });
    }
    if (!found) {
      const { name } = domainVerificationRecord(d.hostname, d.verification_token);
      return save({ error: `No matching TXT record at ${name} yet. DNS changes can take up to an hour.` });
    }
  }
  try {
    let providerId = d.provider_id;
    if (d.status === "pending" || d.status === "failed") {
      ({ providerId } = await provisioner.add(d.hostname));
    }
    const status = await provisioner.status(d.hostname, providerId);
    return save({
      provider_id: providerId,
      verified_at: d.verified_at ?? now,
      status: typeof status === "string" ? status : "failed",
      error: typeof status === "string" ? null : status.failed,
      ...(status === "active" ? { activated_at: now } : {}),
    });
  } catch (err) {
    return save({
      status: "failed",
      verified_at: d.verified_at ?? now,
      error: `The hosting couldn't add the domain: ${(err as Error).message}`.slice(0, 1000),
    });
  }
}

/** Checks every domain still on its way (the worker, every few minutes). */
export async function sweepDomains(deps: DomainDeps): Promise<number> {
  const due = await deps.db
    .selectFrom("institution_domains")
    .select(["id", "status", "created_at"])
    .where("status", "in", ["pending", "provisioning"])
    .execute()
    // A pending domain whose record never appeared stops being checked after a week.
    .then((rows) =>
      rows.filter((r) => r.status === "provisioning" || new Date(r.created_at).getTime() > Date.now() - 7 * 86_400_000),
    );
  for (const { id } of due) await checkDomain(deps, id);
  return due.length;
}
