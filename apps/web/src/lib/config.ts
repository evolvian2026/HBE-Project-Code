import { z } from "zod";

// Read at request time (never NEXT_PUBLIC_*), so one build runs in every environment.
const schema = z.object({
  APP_URL: z.string().url(),
  API_URL: z.string().url(),
  /** Optional private address of the api role (e.g. http://api:4000 on EC2, or the same process). */
  INTERNAL_API_URL: z.string().url().optional(),
  SUPABASE_URL: z.string().url(),
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  /** Institutions' subdomains: <slug>.<this> (Phase 3E). */
  INSTITUTION_BASE_DOMAIN: z.string().optional(),
});

export type WebConfig = z.infer<typeof schema>;

let cached: WebConfig | undefined;

export function webConfig(): WebConfig {
  cached ??= schema.parse({
    APP_URL: process.env.APP_URL,
    API_URL: process.env.API_URL,
    INTERNAL_API_URL: process.env.INTERNAL_API_URL || undefined,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY: process.env.SUPABASE_PUBLISHABLE_KEY,
    INSTITUTION_BASE_DOMAIN: process.env.INSTITUTION_BASE_DOMAIN || undefined,
  });
  return cached;
}

/** Only same-site relative paths are allowed as post-login destinations. */
export function safeNext(value: FormDataEntryValue | string | null | undefined): string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")
    ? value
    : "/";
}
