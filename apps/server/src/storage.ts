import type { Settings } from "@hbe/settings";
import { createClient } from "@supabase/supabase-js";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

/** Private object storage for records (grade reports, source snapshots). */
export interface ObjectStore {
  /** Writes an object, replacing any earlier one at that path. */
  put(bucket: string, path: string, body: Buffer, contentType: string): Promise<void>;
  /** A short-lived URL the grader can PUT one object to, without credentials. */
  signedUploadUrl(bucket: string, path: string): Promise<string>;
  /** Size and content of an object, or null if it doesn't exist. */
  get(bucket: string, path: string): Promise<Buffer | null>;
  /** Deletes objects (missing ones are ignored). */
  remove(bucket: string, paths: string[]): Promise<void>;
  /** The object as a stream (large files: snapshots, exports), or null if it doesn't exist. */
  stream(bucket: string, path: string): Promise<Readable | null>;
  /** A short-lived download URL (for files only the platform may sign, e.g. exports). */
  signedDownloadUrl(bucket: string, path: string, seconds: number, filename: string): Promise<string>;
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
    async signedDownloadUrl(bucket, path, seconds, filename) {
      const { data, error } = await client.storage.from(bucket).createSignedUrl(path, seconds, { download: filename });
      if (error || !data) throw new Error(`Could not sign a download of ${bucket}/${path}: ${error?.message}`);
      return data.signedUrl;
    },
    async stream(bucket, path) {
      const url = `${settings.env.SUPABASE_URL}/storage/v1/object/${bucket}/${path.split("/").map(encodeURIComponent).join("/")}`;
      const key = settings.env.SUPABASE_SECRET_KEY ?? "";
      const res = await fetch(url, { headers: { apikey: key, authorization: `Bearer ${key}` } });
      if (res.status === 400 || res.status === 404) return null;
      if (!res.ok || !res.body) throw new Error(`Storage download of ${bucket}/${path} failed: HTTP ${res.status}`);
      return Readable.fromWeb(res.body as WebReadableStream);
    },
    async remove(bucket, paths) {
      if (!paths.length) return;
      const { error } = await client.storage.from(bucket).remove(paths);
      if (error) throw new Error(`Storage delete in ${bucket} failed: ${error.message}`);
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
  async remove(bucket: string, paths: string[]) {
    for (const path of paths) this.objects.delete(`${bucket}/${path}`);
  }
  async signedDownloadUrl(bucket: string, path: string, seconds: number) {
    return `memory://${bucket}/${path}?download&expires=${seconds}`;
  }
  async stream(bucket: string, path: string) {
    const object = this.objects.get(`${bucket}/${path}`);
    return object ? Readable.from([object.body]) : null;
  }
}
