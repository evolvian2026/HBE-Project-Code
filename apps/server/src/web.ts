import type { FastifyInstance } from "fastify";

/** Placeholder until apps/web exists: the web role serves the Next.js app here. */
export async function mountWeb(_app: FastifyInstance, _dir: string | undefined): Promise<void> {
  throw new Error("The web role is not available yet");
}
