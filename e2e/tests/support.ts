import { createHmac } from "node:crypto";
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
