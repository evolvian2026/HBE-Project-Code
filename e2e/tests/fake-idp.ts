import { randomUUID, X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { SignedXml } from "xml-crypto";

/**
 * A SAML 2.0 identity provider standing in for an institution's (Okta, Entra ID, Shibboleth…)
 * in E2E tests: its login page asks for an email address and posts a signed assertion for it
 * back to Supabase Auth, as a real IdP does after the person signs in there.
 */
export interface FakeIdp {
  entityId: string;
  metadataXml: string;
  close(): Promise<void>;
}

const escape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A signing key and its self-signed certificate (openssl is on every CI runner). */
function signingCert(): { key: string; certPem: string } {
  const dir = mkdtempSync(join(tmpdir(), "fake-idp-"));
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(dir, "k.pem"),
        "-out",
        join(dir, "c.pem"),
        "-days",
        "2",
        "-subj",
        "/CN=fake-idp",
      ],
      { stdio: "ignore" },
    );
    const certPem = readFileSync(join(dir, "c.pem"), "utf8");
    new X509Certificate(certPem); // valid
    return { key: readFileSync(join(dir, "k.pem"), "utf8"), certPem };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const NS = 'xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"';

export async function startFakeIdp(port: number): Promise<FakeIdp> {
  const base = `http://127.0.0.1:${port}`;
  const entityId = `${base}/idp`;
  const { key, certPem } = signingCert();
  const certBody = certPem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");

  function signedResponse(req: { id: string; acs: string; audience: string }, email: string): string {
    const now = new Date();
    const at = (ms: number) => new Date(now.getTime() + ms).toISOString();
    const assertionId = `_${randomUUID()}`;
    const xml =
      `<samlp:Response ${NS} ID="_${randomUUID()}" Version="2.0" IssueInstant="${at(0)}" Destination="${escape(req.acs)}" InResponseTo="${escape(req.id)}">` +
      `<saml:Issuer>${entityId}</saml:Issuer>` +
      `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
      `<saml:Assertion ID="${assertionId}" Version="2.0" IssueInstant="${at(0)}">` +
      `<saml:Issuer>${entityId}</saml:Issuer>` +
      `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${escape(email)}</saml:NameID>` +
      `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">` +
      `<saml:SubjectConfirmationData InResponseTo="${escape(req.id)}" NotOnOrAfter="${at(300_000)}" Recipient="${escape(req.acs)}"/>` +
      `</saml:SubjectConfirmation></saml:Subject>` +
      `<saml:Conditions NotBefore="${at(-60_000)}" NotOnOrAfter="${at(300_000)}">` +
      `<saml:AudienceRestriction><saml:Audience>${escape(req.audience)}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
      `<saml:AuthnStatement AuthnInstant="${at(0)}" SessionIndex="_${randomUUID()}"><saml:AuthnContext>` +
      `<saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef>` +
      `</saml:AuthnContext></saml:AuthnStatement>` +
      `<saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>${escape(email)}</saml:AttributeValue></saml:Attribute></saml:AttributeStatement>` +
      `</saml:Assertion></samlp:Response>`;
    const sig = new SignedXml({
      privateKey: key,
      publicCert: certPem,
      signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
      canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
    });
    sig.addReference({
      xpath: `//*[@ID='${assertionId}']`,
      digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
      transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/2001/10/xml-exc-c14n#"],
    });
    sig.computeSignature(xml, {
      location: { reference: `//*[@ID='${assertionId}']/*[local-name(.)='Issuer']`, action: "after" },
    });
    return sig.getSignedXml();
  }

  /** What the AuthnRequest (HTTP-Redirect binding: deflated, base64) asks for. */
  function parseRequest(samlRequest: string) {
    const xml = inflateRawSync(Buffer.from(samlRequest, "base64")).toString("utf8");
    const attr = (name: string) => new RegExp(`${name}="([^"]+)"`).exec(xml)?.[1] ?? "";
    const issuer = /<(?:saml:)?Issuer[^>]*>([^<]+)</.exec(xml)?.[1] ?? "";
    return { id: attr("ID"), acs: attr("AssertionConsumerServiceURL"), audience: issuer };
  }

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", base);
    const page = (html: string) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><head><title>Institution sign-in</title></head><body>${html}</body></html>`);
    };
    if (req.method === "GET" && url.pathname === "/sso") {
      // The institution's own sign-in page.
      const hidden = ["SAMLRequest", "RelayState"]
        .map((k) => `<input type="hidden" name="${k}" value="${escape(url.searchParams.get(k) ?? "")}">`)
        .join("");
      return page(
        `<h1>Example University sign-in</h1><form method="post" action="/login">${hidden}` +
          `<label>University email <input name="email" type="email"></label><button>Sign in</button></form>`,
      );
    }
    if (req.method === "POST" && url.pathname === "/login") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const form = new URLSearchParams(body);
        const request = parseRequest(form.get("SAMLRequest") ?? "");
        const response = Buffer.from(signedResponse(request, form.get("email") ?? "")).toString("base64");
        // HTTP-POST binding back to the service provider.
        page(
          `<form id="f" method="post" action="${escape(request.acs)}">` +
            `<input type="hidden" name="SAMLResponse" value="${response}">` +
            `<input type="hidden" name="RelayState" value="${escape(form.get("RelayState") ?? "")}">` +
            `<noscript><button>Continue</button></noscript></form><script>document.getElementById("f").submit()</script>`,
        );
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

  const metadataXml =
    `<?xml version="1.0"?><md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${entityId}">` +
    `<md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">` +
    `<md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data>` +
    `<ds:X509Certificate>${certBody}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>` +
    `<md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>` +
    `<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${base}/sso"/>` +
    `</md:IDPSSODescriptor></md:EntityDescriptor>`;
  return { entityId, metadataXml, close: () => new Promise((r) => server.close(() => r())) };
}
