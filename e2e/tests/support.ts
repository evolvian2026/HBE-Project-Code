import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import pg from "pg";

const MAILPIT_URL = process.env.MAILPIT_URL ?? "http://127.0.0.1:54324";
const DATABASE_URL = process.env.E2E_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

export async function sql<T = unknown>(text: string, values: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return (await client.query(text, values)).rows as T[];
  } finally {
    await client.end();
  }
}

/** Polls Mailpit for the newest sign-in link sent to `email`. */
async function waitForMagicLink(email: string, sentAfter: number): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const res = await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
    const { messages = [] } = (await res.json()) as { messages?: { ID: string; Created: string }[] };
    const latest = messages.find((m) => Date.parse(m.Created) >= sentAfter - 1000);
    if (latest) {
      const message = (await (await fetch(`${MAILPIT_URL}/api/v1/message/${latest.ID}`)).json()) as { Text: string };
      const link = message.Text.match(/https?:\/\/\S+\/auth\/v1\/verify\?\S+/)?.[0];
      if (link) return link.replace(/[)\]>.,]+$/, "");
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`No sign-in email for ${email}`);
}

/** Signs in through the real UI and email flow. */
export async function signIn(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  const sentAfter = Date.now();
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByText(`Check ${email} for a sign-in link.`)).toBeVisible();
  await page.goto(await waitForMagicLink(email, sentAfter));
  await expect(page).not.toHaveURL(/\/login/);
}

/** Creates an institution and a pending admin invitation directly in the database (test setup). */
export async function createInstitutionWithAdmin(slug: string, name: string, adminEmail: string): Promise<string> {
  const [inst] = await sql<{ id: string }>(
    "insert into public.institutions (name, slug) values ($1, $2) returning id",
    [name, slug],
  );
  await sql("insert into public.invitations (institution_id, email, role) values ($1, $2, 'admin')", [
    inst!.id,
    adminEmail,
  ]);
  return inst!.id;
}

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s), as authenticator apps compute it. */
export function totp(base32Secret: string, now = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of base32Secret.replace(/=+$/, "").toUpperCase())
    bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / 30)));
  const hmac = createHmac("sha1", key).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0xf;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

/** Completes the "admins must set up two-factor" page; returns the TOTP secret. */
export async function setUpMfa(page: Page): Promise<string> {
  await expect(page).toHaveURL(/\/account\/security\?/);
  await expect(page.getByText("Admins must use two-factor authentication.")).toBeVisible();
  await page.getByRole("button", { name: "Set up authenticator app" }).click();
  const secret = (await page.getByTestId("totp-secret").textContent())!.trim();
  await page.getByLabel("Code").fill(totp(secret));
  await page.getByRole("button", { name: "Verify and turn on" }).click();
  await expect(page).not.toHaveURL(/\/account\/security/);
  return secret;
}

/** Answers the two-factor challenge shown at sign-in. */
export async function passMfa(page: Page, secret: string): Promise<void> {
  await expect(page).toHaveURL(/\/auth\/mfa/);
  await page.getByLabel("Code").fill(totp(secret));
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).not.toHaveURL(/\/auth\/mfa/);
}

const WEBHOOK_SECRET = process.env.E2E_WEBHOOK_SECRET ?? "local-secret";

/** Sends a webhook signed like GitHub does. */
export async function sendWebhook(baseURL: string, event: string, payload: unknown): Promise<void> {
  const body = JSON.stringify(payload);
  const res = await fetch(`${baseURL}/webhooks/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": randomUUID(),
      "x-hub-signature-256": `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`,
    },
    body,
  });
  expect(res.status).toBe(202);
}

/**
 * Plays the grader for a run the worker dispatched to the in-memory GitHub: gives the run a
 * known callback token, then reports `started` and the given results like the harness does.
 */
export async function reportRun(
  baseURL: string,
  runId: string,
  results: Record<string, unknown>,
  opts: { snapshot?: { bundle: Buffer; tarball: Buffer } } = {},
): Promise<void> {
  const token = randomBytes(24).toString("base64url");
  await sql("update public.evaluation_runs set callback_token_hash = $2 where id = $1", [
    runId,
    createHash("sha256").update(token).digest("hex"),
  ]);
  const call = async (path: string, body: unknown) => {
    const res = await fetch(`${baseURL}/v1/runs/${runId}/${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    return res.json();
  };
  await call("started", {});
  let snapshot: Record<string, unknown> | undefined;
  if (opts.snapshot) {
    // Upload like the harness: to the signed URLs the platform hands out, then report the hashes.
    const targets = (await call("snapshot-uploads", {})) as Record<"bundle" | "tarball", { url: string }>;
    snapshot = {};
    for (const [kind, type] of [
      ["bundle", "application/x-git-bundle"],
      ["tarball", "application/gzip"],
    ] as const) {
      const body = opts.snapshot[kind];
      const res = await fetch(targets[kind].url, {
        method: "PUT",
        headers: { "content-type": type },
        body: new Uint8Array(body),
      });
      expect(res.status).toBe(200);
      snapshot[`${kind}_sha256`] = createHash("sha256").update(body).digest("hex");
      snapshot[`${kind}_size`] = body.length;
    }
  }
  await call("results", { ...results, ...(snapshot ? { snapshot } : {}) });
}
