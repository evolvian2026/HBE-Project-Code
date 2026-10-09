import { exportJWK, generateKeyPair, importPKCS8, type CryptoKey, type JWK } from "jose";

/** The tool's signing key (RS256): LTI messages to platforms and client assertions. */
export interface ToolKey {
  kid: string;
  privateKey: CryptoKey;
  publicJwk: JWK;
}

export interface ToolKeys {
  /** Signs everything. */
  current: ToolKey;
  /** Still published in the JWKS during a key rollover, never used to sign. */
  previous?: ToolKey;
}

async function fromPem(pem: string, kid: string): Promise<ToolKey> {
  const privateKey = await importPKCS8(pem, "RS256", { extractable: true });
  const jwk = await exportJWK(privateKey);
  const publicJwk: JWK = { kty: jwk.kty, n: jwk.n, e: jwk.e };
  return { kid, privateKey, publicJwk: { ...publicJwk, kid, alg: "RS256", use: "sig" } };
}

/** Loads the tool's keys from PKCS#8 PEM (base64 in the environment). */
export async function loadToolKeys(
  current: { pem: string; kid: string },
  previous?: { pem: string; kid: string },
): Promise<ToolKeys> {
  return {
    current: await fromPem(current.pem, current.kid),
    ...(previous ? { previous: await fromPem(previous.pem, previous.kid) } : {}),
  };
}

/** A fresh key (local development and tests). */
export async function generateToolKey(kid = `local-${Date.now()}`): Promise<ToolKey> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  return { kid, privateKey, publicJwk: { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" } };
}

/** The public JWKS platforms fetch to verify the tool's signatures. */
export function toolJwks(keys: ToolKeys): { keys: JWK[] } {
  return { keys: [keys.current.publicJwk, ...(keys.previous ? [keys.previous.publicJwk] : [])] };
}
