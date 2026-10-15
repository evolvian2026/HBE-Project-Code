import { SLUG_PATTERN } from "./slug.ts";

/**
 * Institution addresses (Phase 3E): `<slug>.<base domain>` when the platform has a base domain
 * for institutions, and one vanity domain per institution (e.g. projects.example.edu) once its
 * admin proves they own it with a DNS TXT record and the platform serves it. The platform's
 * own address (APP_URL) always works too.
 */

/** Never institution subdomains (they name the platform's own services). */
export const RESERVED_SUBDOMAINS = new Set([
  "www",
  "app",
  "api",
  "admin",
  "platform",
  "auth",
  "mail",
  "email",
  "static",
  "assets",
  "cdn",
  "grader",
  "status",
  "docs",
  "help",
  "support",
]);

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * A hostname as an admin typed it (maybe with a scheme, path, port or trailing dot), in
 * lowercase ASCII (internationalised names in punycode), or null when it isn't one: at least
 * two labels, no IP addresses, no underscores, 253 characters at most.
 */
export function normalizeHostname(input: string): string | null {
  const raw = input.trim().toLowerCase();
  if (!raw || /\s/.test(raw)) return null;
  let host: string;
  try {
    host = new URL(raw.includes("://") ? raw : `http://${raw}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/\.$/, "");
  if (host.length > 253 || /^[\d.]+$/.test(host) || host.includes(":")) return null;
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return null;
  if (/^\d+$/.test(labels.at(-1)!)) return null;
  return host;
}

export interface AddressConfig {
  /** The platform's address (APP_URL). */
  appUrl: string;
  /** Institutions' parent domain (INSTITUTION_BASE_DOMAIN), if any. */
  baseDomain?: string | null;
  /** Other hosts that are the platform's own (the API's, when it has its own). */
  platformHosts?: string[];
}

export type HostKind =
  | { kind: "platform" }
  | { kind: "subdomain"; slug: string }
  | { kind: "custom"; hostname: string }
  | { kind: "invalid" };

const hostnameOf = (host: string) => host.toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");

/** What a request's Host header names: the platform, an institution's subdomain, or another domain. */
export function classifyHost(host: string | null | undefined, cfg: AddressConfig): HostKind {
  if (!host) return { kind: "platform" };
  const name = hostnameOf(host);
  const platform = [new URL(cfg.appUrl).hostname, ...(cfg.platformHosts ?? [])].map(hostnameOf);
  if (platform.includes(name)) return { kind: "platform" };
  const base = cfg.baseDomain ? hostnameOf(cfg.baseDomain) : null;
  if (base && name === base) return { kind: "platform" };
  if (base && name.endsWith(`.${base}`)) {
    const label = name.slice(0, -base.length - 1);
    return SLUG_PATTERN.test(label) && !RESERVED_SUBDOMAINS.has(label)
      ? { kind: "subdomain", slug: label }
      : { kind: "invalid" };
  }
  const normalized = normalizeHostname(name);
  return normalized ? { kind: "custom", hostname: normalized } : { kind: "invalid" };
}

/**
 * Why a hostname can't be an institution's vanity domain, or null: it is the platform's own
 * address, or under the institutions' base domain (those are subdomains already).
 */
export function customDomainProblem(hostname: string, cfg: AddressConfig): string | null {
  const kind = classifyHost(hostname, cfg).kind;
  if (kind === "platform") return "That is the platform's own address.";
  if (kind === "subdomain" || kind === "invalid") {
    return `Addresses under ${cfg.baseDomain} are institutions' own subdomains; use a domain of yours.`;
  }
  return null;
}

/**
 * Where an institution's pages are: its live vanity domain, else its subdomain, else the
 * platform's address. Same scheme (and, locally, port) as APP_URL; no trailing slash.
 */
export function institutionBaseUrl(cfg: AddressConfig, inst: { slug: string; customDomain?: string | null }): string {
  const app = new URL(cfg.appUrl);
  const port = app.port ? `:${app.port}` : "";
  if (inst.customDomain) return `${app.protocol}//${inst.customDomain}${port}`;
  if (cfg.baseDomain && !RESERVED_SUBDOMAINS.has(inst.slug)) {
    return `${app.protocol}//${inst.slug}.${hostnameOf(cfg.baseDomain)}${port}`;
  }
  return app.origin;
}

/** The DNS TXT record that proves an institution controls a domain. */
export function domainVerificationRecord(hostname: string, token: string): { name: string; value: string } {
  return { name: `_hbe-verify.${hostname}`, value: `hbe-verify=${token}` };
}
