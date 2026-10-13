import type { Settings } from "@hbe/settings";

/** Supabase Auth's SAML identity providers (its admin API, with the project's secret key). */
export interface SsoAdmin {
  /** Registers the IdP for these email domains; returns the provider's id. */
  createProvider(input: { metadataUrl?: string; metadataXml?: string; domains: string[] }): Promise<string>;
  setDisabled(providerId: string, disabled: boolean): Promise<void>;
}

export class SsoAdminError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SsoAdminError";
  }
}

export function supabaseSsoAdmin(settings: Settings, fetchImpl: typeof fetch = fetch): SsoAdmin {
  const base = `${settings.env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/admin/sso/providers`;
  const key = settings.env.SUPABASE_SECRET_KEY ?? "";
  const call = async (method: string, url: string, body: unknown) => {
    const res = await fetchImpl(url, {
      method,
      headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => ({}))) as { id?: string; msg?: string; message?: string };
    if (!res.ok) {
      throw new SsoAdminError(json.msg ?? json.message ?? `Supabase Auth answered ${res.status}`, res.status);
    }
    return json;
  };
  return {
    async createProvider({ metadataUrl, metadataXml, domains }) {
      const json = await call("POST", base, {
        type: "saml",
        ...(metadataUrl ? { metadata_url: metadataUrl } : { metadata_xml: metadataXml }),
        domains,
        // Email from the assertion's NameID or an "email" attribute (the common IdP defaults).
        attribute_mapping: {
          keys: {
            email: { names: ["email", "mail", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"] },
          },
        },
      });
      if (!json.id) throw new SsoAdminError("Supabase Auth didn't return the provider", 502);
      return json.id;
    },
    async setDisabled(providerId, disabled) {
      await call("PUT", `${base}/${providerId}`, { disabled });
    },
  };
}
