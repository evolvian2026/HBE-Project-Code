import { classifyHost, type AddressConfig } from "@hbe/core";
import { webConfig } from "./config";

/**
 * Which institution a request's host serves (Phase 3E): none for the platform's own address,
 * else the slug the api reports for it (a subdomain of an existing institution, or a live
 * vanity domain). Answers are cached for a minute (unknown hosts for 15 seconds).
 */
const cache = new Map<string, { slug: string | null; until: number }>();

export function addressConfig(): AddressConfig {
  const { APP_URL, API_URL, INSTITUTION_BASE_DOMAIN } = webConfig();
  return { appUrl: APP_URL, baseDomain: INSTITUTION_BASE_DOMAIN ?? null, platformHosts: [new URL(API_URL).hostname] };
}

export type HostLookup = { platform: true } | { platform: false; slug: string | null };

export async function lookupHost(host: string | null): Promise<HostLookup> {
  const kind = classifyHost(host, addressConfig());
  if (kind.kind === "platform") return { platform: true };
  if (kind.kind === "invalid" || !host) return { platform: false, slug: null };
  const key = host.toLowerCase();
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return { platform: false, slug: hit.slug };
  const { API_URL, INTERNAL_API_URL } = webConfig();
  let slug: string | null = null;
  try {
    const res = await fetch(new URL(`/v1/hosts/${encodeURIComponent(key)}`, INTERNAL_API_URL ?? API_URL), {
      cache: "no-store",
    });
    if (res.ok) slug = ((await res.json()) as { slug: string }).slug;
    else if (res.status !== 404) return { platform: false, slug: hit?.slug ?? null }; // keep a known answer
  } catch {
    return { platform: false, slug: hit?.slug ?? null };
  }
  cache.set(key, { slug, until: Date.now() + (slug ? 60_000 : 15_000) });
  return { platform: false, slug };
}

/** Top-level routes of the app itself; any other path on an institution's address is under /i/<slug>. */
export const APP_ROUTES = new Set(["i", "account", "auth", "github", "login", "lti", "platform", "signed-out"]);
