import { describe, expect, it } from "vitest";
import {
  classifyHost,
  customDomainProblem,
  domainVerificationRecord,
  institutionBaseUrl,
  normalizeHostname,
} from "./domains.ts";

const cfg = { appUrl: "https://app.hbe.example", baseDomain: "hbe.example", platformHosts: ["api.hbe.example"] };

describe("hostnames", () => {
  it("normalise what admins type, and refuse what isn't a hostname", () => {
    expect(normalizeHostname(" Projects.Example.EDU. ")).toBe("projects.example.edu");
    expect(normalizeHostname("https://projects.example.edu:8443/courses")).toBe("projects.example.edu");
    expect(normalizeHostname("bücher.example")).toBe("xn--bcher-kva.example");
    for (const bad of ["localhost", "10.0.0.1", "-bad.example.com", "a_b.example.com", "two words.com", "x.123", ""]) {
      expect(normalizeHostname(bad), bad).toBeNull();
    }
  });
});

describe("hosts", () => {
  it("tell the platform, institutions' subdomains and vanity domains apart", () => {
    expect(classifyHost("app.hbe.example", cfg)).toEqual({ kind: "platform" });
    expect(classifyHost("api.hbe.example:443", cfg)).toEqual({ kind: "platform" });
    expect(classifyHost("hbe.example", cfg)).toEqual({ kind: "platform" });
    expect(classifyHost(null, cfg)).toEqual({ kind: "platform" });
    expect(classifyHost("acme.hbe.example", cfg)).toEqual({ kind: "subdomain", slug: "acme" });
    expect(classifyHost("www.hbe.example", cfg)).toEqual({ kind: "invalid" });
    expect(classifyHost("a.b.hbe.example", cfg)).toEqual({ kind: "invalid" });
    expect(classifyHost("Projects.Example.edu", cfg)).toEqual({ kind: "custom", hostname: "projects.example.edu" });
  });

  it("work locally on *.localhost with a port", () => {
    const local = { appUrl: "http://localhost:3000", baseDomain: "localhost" };
    expect(classifyHost("localhost:3000", local)).toEqual({ kind: "platform" });
    expect(classifyHost("acme.localhost:3000", local)).toEqual({ kind: "subdomain", slug: "acme" });
    expect(institutionBaseUrl(local, { slug: "acme" })).toBe("http://acme.localhost:3000");
  });

  it("refuse the platform's own addresses as vanity domains", () => {
    expect(customDomainProblem("projects.example.edu", cfg)).toBeNull();
    expect(customDomainProblem("app.hbe.example", cfg)).toMatch(/platform's own/);
    expect(customDomainProblem("acme.hbe.example", cfg)).toMatch(/subdomains/);
  });
});

describe("institution addresses", () => {
  it("prefer the live vanity domain, then the subdomain, then the platform", () => {
    expect(institutionBaseUrl(cfg, { slug: "acme", customDomain: "projects.example.edu" })).toBe(
      "https://projects.example.edu",
    );
    expect(institutionBaseUrl(cfg, { slug: "acme" })).toBe("https://acme.hbe.example");
    expect(institutionBaseUrl({ appUrl: "https://app.hbe.example/" }, { slug: "acme" })).toBe(
      "https://app.hbe.example",
    );
  });

  it("verify ownership with a TXT record", () => {
    expect(domainVerificationRecord("projects.example.edu", "t0k")).toEqual({
      name: "_hbe-verify.projects.example.edu",
      value: "hbe-verify=t0k",
    });
  });
});
