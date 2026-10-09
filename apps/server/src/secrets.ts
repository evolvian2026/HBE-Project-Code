import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { Settings } from "@hbe/settings";

const PREFIX = "v1:";

function keyOf(settings: Settings): Buffer {
  const value = settings.env.TOKEN_ENCRYPTION_KEY;
  if (!value) throw new Error("TOKEN_ENCRYPTION_KEY is not set");
  const raw = Buffer.from(value, "base64");
  if (raw.length === 32) return raw;
  // Settings refuse other values outside local development, where any string will do.
  return createHash("sha256").update(value).digest();
}

/**
 * Encrypts a secret for storage (OAuth refresh tokens) with AES-256-GCM under
 * TOKEN_ENCRYPTION_KEY: `v1:` + base64(iv | tag | ciphertext). The database never sees the
 * plain value, and a changed key fails loudly instead of returning garbage.
 */
export function sealSecret(settings: Settings, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyOf(settings), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
}

export function openSecret(settings: Settings, sealed: string): string {
  if (!sealed.startsWith(PREFIX)) throw new Error("Unknown secret format");
  const raw = Buffer.from(sealed.slice(PREFIX.length), "base64");
  const decipher = createDecipheriv("aes-256-gcm", keyOf(settings), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}
