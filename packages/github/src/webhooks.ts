import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/**
 * Verifies GitHub's X-Hub-Signature-256 header (HMAC-SHA256 of the raw body)
 * with a constant-time comparison. The raw bytes must be used: re-serialised
 * JSON does not match.
 */
export function verifyWebhookSignature(secret: string, rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const received = Buffer.from(signatureHeader.slice("sha256=".length), "hex");
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function signWebhookBody(secret: string, rawBody: Buffer | string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

const headersSchema = z.object({
  "x-github-delivery": z.string().min(1).max(100),
  "x-github-event": z.string().regex(/^[a-z_]+$/),
  "x-hub-signature-256": z.string().optional(),
});

export interface WebhookHeaders {
  deliveryId: string;
  event: string;
  signature: string | undefined;
}

export function parseWebhookHeaders(headers: Record<string, unknown>): WebhookHeaders | null {
  const parsed = headersSchema.safeParse(headers);
  if (!parsed.success) return null;
  return {
    deliveryId: parsed.data["x-github-delivery"],
    event: parsed.data["x-github-event"],
    signature: parsed.data["x-hub-signature-256"],
  };
}

const account = z.object({ id: z.number().int(), login: z.string(), type: z.string() }).passthrough();
const user = z.object({ id: z.number().int(), login: z.string() }).passthrough();

/** Fields every stored event is indexed by. All are optional in GitHub's payloads. */
const envelopeSchema = z
  .object({
    action: z.string().optional(),
    installation: z.object({ id: z.number().int() }).passthrough().optional(),
    repository: z.object({ full_name: z.string() }).passthrough().optional(),
    sender: user.optional(),
  })
  .passthrough();

export interface WebhookEnvelope {
  action: string | null;
  installationId: number | null;
  repositoryFullName: string | null;
  senderId: number | null;
}

export function extractEnvelope(payload: unknown): WebhookEnvelope {
  const parsed = envelopeSchema.safeParse(payload);
  const p = parsed.success ? parsed.data : {};
  return {
    action: "action" in p ? (p.action ?? null) : null,
    installationId: "installation" in p ? (p.installation?.id ?? null) : null,
    repositoryFullName: "repository" in p ? (p.repository?.full_name ?? null) : null,
    senderId: "sender" in p ? (p.sender?.id ?? null) : null,
  };
}

/** `installation` webhook: created, deleted, suspend, unsuspend, new_permissions_accepted. */
export const installationEventSchema = z.object({
  action: z.enum(["created", "deleted", "suspend", "unsuspend", "new_permissions_accepted"]),
  installation: z
    .object({
      id: z.number().int(),
      account: account,
      repository_selection: z.string().optional(),
      permissions: z.record(z.string()).default({}),
      events: z.array(z.string()).default([]),
      suspended_at: z.string().nullable().optional(),
    })
    .passthrough(),
  sender: user,
});
export type InstallationEvent = z.infer<typeof installationEventSchema>;

/** Where an institution admin installs the App. */
export function installAppUrl(appSlug: string): string {
  return `https://github.com/apps/${encodeURIComponent(appSlug)}/installations/new`;
}

const repoRef = z.object({ id: z.number().int(), full_name: z.string() }).passthrough();

/** `push`: commits on a branch (GitHub includes at most 20 in the payload). */
export const pushEventSchema = z.object({
  ref: z.string(),
  /** The pushed branch's new head commit. */
  after: z.string().optional(),
  deleted: z.boolean().optional(),
  /** pushed_at: Unix time of the push, used to order deliveries. */
  repository: repoRef.extend({ pushed_at: z.number().optional() }),
  commits: z
    .array(
      z.object({
        id: z.string().regex(/^[0-9a-f]{40}$/),
        message: z.string(),
        timestamp: z.string(),
        distinct: z.boolean().default(true),
        author: z.object({ username: z.string().optional() }).passthrough().optional(),
      }),
    )
    .default([]),
});
export type PushEvent = z.infer<typeof pushEventSchema>;

export const pullRequestEventSchema = z.object({
  action: z.string(),
  repository: repoRef,
  pull_request: z
    .object({
      id: z.number().int(),
      number: z.number().int(),
      title: z.string(),
      body: z.string().nullable().optional(),
      state: z.enum(["open", "closed"]),
      merged_at: z.string().nullable().optional(),
      created_at: z.string(),
      closed_at: z.string().nullable().optional(),
      user: z.object({ id: z.number().int(), login: z.string() }).passthrough(),
      head: z.object({ sha: z.string() }).passthrough().optional(),
    })
    .passthrough(),
});
export type PullRequestEvent = z.infer<typeof pullRequestEventSchema>;

export const pullRequestReviewEventSchema = z.object({
  action: z.string(),
  repository: repoRef,
  pull_request: z.object({ number: z.number().int() }).passthrough(),
  review: z
    .object({
      id: z.number().int(),
      state: z.string(),
      submitted_at: z.string().nullable().optional(),
      user: z.object({ id: z.number().int() }).passthrough().nullable(),
    })
    .passthrough(),
});
export type PullRequestReviewEvent = z.infer<typeof pullRequestReviewEventSchema>;

export const issuesEventSchema = z.object({
  action: z.string(),
  repository: repoRef,
  issue: z
    .object({
      id: z.number().int(),
      number: z.number().int(),
      title: z.string(),
      state: z.enum(["open", "closed"]),
      created_at: z.string(),
      closed_at: z.string().nullable().optional(),
      user: z.object({ id: z.number().int() }).passthrough(),
    })
    .passthrough(),
});
export type IssuesEvent = z.infer<typeof issuesEventSchema>;
