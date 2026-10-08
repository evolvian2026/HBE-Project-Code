import type { Settings } from "@hbe/settings";
import { createClient } from "@supabase/supabase-js";

/** Private object storage for records (grade reports, source snapshots). */
export interface ObjectStore {
  /** Writes an object, replacing any earlier one at that path. */
  put(bucket: string, path: string, body: Buffer, contentType: string): Promise<void>;
  /** A short-lived URL the grader can PUT one object to, without credentials. */
  signedUploadUrl(bucket: string, path: string): Promise<string>;
  /** Size and content of an object, or null if it doesn't exist. */
  get(bucket: string, path: string): Promise<Buffer | null>;
}

/** Supabase Storage, with the platform's secret key (the server side only). */
export function supabaseObjectStore(settings: Settings): ObjectStore {
  // Settings require the secret key whenever the api or worker role runs.
  const client = createClient(settings.env.SUPABASE_URL, settings.env.SUPABASE_SECRET_KEY ?? "", {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return {
    async put(bucket, path, body, contentType) {
      const { error } = await client.storage.from(bucket).upload(path, body, { contentType, upsert: true });
      if (error) throw new Error(`Storage upload of ${bucket}/${path} failed: ${error.message}`);
    },
    async signedUploadUrl(bucket, path) {
      const { data, error } = await client.storage.from(bucket).createSignedUploadUrl(path, { upsert: true });
      if (error || !data) throw new Error(`Could not sign an upload to ${bucket}/${path}: ${error?.message}`);
      return data.signedUrl;
    },
    async get(bucket, path) {
      const { data, error } = await client.storage.from(bucket).download(path);
      if (error || !data) return null;
      return Buffer.from(await data.arrayBuffer());
    },
  };
}

/** In-memory store for tests. */
export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();
  async put(bucket: string, path: string, body: Buffer, contentType: string) {
    this.objects.set(`${bucket}/${path}`, { body, contentType });
  }
  async signedUploadUrl(bucket: string, path: string) {
    return `memory://${bucket}/${path}?token=test`;
  }
  async get(bucket: string, path: string) {
    return this.objects.get(`${bucket}/${path}`)?.body ?? null;
  }
}
