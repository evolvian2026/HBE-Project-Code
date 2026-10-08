import { describe, expect, it } from "vitest";
import {
  extractEnvelope,
  installationEventSchema,
  parseWebhookHeaders,
  signWebhookBody,
  verifyWebhookSignature,
} from "./webhooks.ts";

describe("verifyWebhookSignature", () => {
  // Test vector from GitHub's "Validating webhook deliveries" documentation.
  const secret = "It's a Secret to Everybody";
  const body = Buffer.from("Hello, World!");
  const signature = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";

  it("accepts GitHub's documented example", () => {
    expect(verifyWebhookSignature(secret, body, signature)).toBe(true);
    expect(signWebhookBody(secret, body)).toBe(signature);
  });

  it("rejects a wrong secret, a modified body, or a malformed header", () => {
    expect(verifyWebhookSignature("wrong", body, signature)).toBe(false);
    expect(verifyWebhookSignature(secret, Buffer.from("Hello, World?"), signature)).toBe(false);
    expect(verifyWebhookSignature(secret, body, undefined)).toBe(false);
    expect(verifyWebhookSignature(secret, body, "sha1=abc")).toBe(false);
    expect(verifyWebhookSignature(secret, body, "sha256=abcd")).toBe(false);
  });
});

describe("parseWebhookHeaders", () => {
  it("reads delivery id, event and signature", () => {
    expect(
      parseWebhookHeaders({ "x-github-delivery": "d-1", "x-github-event": "push", "x-hub-signature-256": "sha256=00" }),
    ).toEqual({ deliveryId: "d-1", event: "push", signature: "sha256=00" });
  });

  it("rejects missing or odd event names", () => {
    expect(parseWebhookHeaders({ "x-github-event": "push" })).toBeNull();
    expect(parseWebhookHeaders({ "x-github-delivery": "d", "x-github-event": "../etc" })).toBeNull();
  });
});

describe("extractEnvelope", () => {
  it("pulls indexing fields when present", () => {
    expect(
      extractEnvelope({
        action: "opened",
        installation: { id: 42 },
        repository: { full_name: "org/repo" },
        sender: { id: 7, login: "octocat" },
      }),
    ).toEqual({ action: "opened", installationId: 42, repositoryFullName: "org/repo", senderId: 7 });
  });

  it("tolerates payloads without them", () => {
    expect(extractEnvelope({ zen: "Keep it logically awesome." })).toEqual({
      action: null,
      installationId: null,
      repositoryFullName: null,
      senderId: null,
    });
    expect(extractEnvelope("not an object")).toEqual({
      action: null,
      installationId: null,
      repositoryFullName: null,
      senderId: null,
    });
  });
});

describe("installationEventSchema", () => {
  it("parses an installation.created payload", () => {
    const event = installationEventSchema.parse({
      action: "created",
      installation: {
        id: 1,
        account: { id: 10, login: "alpha-cs", type: "Organization" },
        repository_selection: "all",
        permissions: { contents: "read", metadata: "read" },
        events: ["push"],
      },
      sender: { id: 99, login: "admin-a" },
    });
    expect(event.installation.account.login).toBe("alpha-cs");
    expect(event.sender.id).toBe(99);
  });
});
