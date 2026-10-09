import { DeleteObjectsCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Settings } from "@hbe/settings";
import { Readable } from "node:stream";

/**
 * The external archive bucket (docs/ARCHITECTURE.md §12.4): S3, Cloudflare R2 or any
 * S3-compatible store. Holds replicas of the record files and full exports.
 */
export interface ArchiveStore {
  /** e.g. "r2.example.com/hbe-records (lock=none)", for logs. */
  readonly description: string;
  /** Whether objects are written under Object Lock (and so need a retain-until date). */
  readonly locking: boolean;
  /** Uploads an object (multipart for streams), under Object Lock until `lockUntil` if locking. */
  put(key: string, body: Readable | Buffer, opts: { contentType: string; lockUntil?: Date | null }): Promise<void>;
  /** Deletes objects; governance-mode locks are bypassed (the retention purge). */
  remove(keys: string[]): Promise<void>;
  /** A short-lived download URL. */
  downloadUrl(key: string, seconds: number, filename: string): Promise<string>;
  /** The object's content, or null (restore drills and tests). */
  get(key: string): Promise<Buffer | null>;
}

/** The configured archive bucket, or null when ARCHIVE_S3_BUCKET isn't set (local development). */
export function s3ArchiveStore(settings: Settings): ArchiveStore | null {
  const env = settings.env;
  if (!env.ARCHIVE_S3_BUCKET) return null;
  const bucket = env.ARCHIVE_S3_BUCKET;
  const client = new S3Client({
    region: env.ARCHIVE_S3_REGION,
    ...(env.ARCHIVE_S3_ENDPOINT ? { endpoint: env.ARCHIVE_S3_ENDPOINT, forcePathStyle: true } : {}),
    // Without keys the default chain applies (e.g. the EC2 instance role).
    ...(env.ARCHIVE_S3_ACCESS_KEY_ID
      ? {
          credentials: {
            accessKeyId: env.ARCHIVE_S3_ACCESS_KEY_ID,
            secretAccessKey: env.ARCHIVE_S3_SECRET_ACCESS_KEY ?? "",
          },
        }
      : {}),
  });
  const lock = env.ARCHIVE_OBJECT_LOCK;
  return {
    description: `${env.ARCHIVE_S3_ENDPOINT ? new URL(env.ARCHIVE_S3_ENDPOINT).host : "aws-s3"}/${bucket} (lock=${lock})`,
    locking: lock !== "none",
    async put(key, body, { contentType, lockUntil }) {
      await new Upload({
        client,
        params: {
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          ...(lock !== "none" && lockUntil
            ? {
                ObjectLockMode: lock === "compliance" ? "COMPLIANCE" : "GOVERNANCE",
                ObjectLockRetainUntilDate: lockUntil,
              }
            : {}),
        },
      }).done();
    },
    async remove(keys) {
      for (let i = 0; i < keys.length; i += 1000) {
        const res = await client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true },
            ...(lock === "governance" ? { BypassGovernanceRetention: true } : {}),
          }),
        );
        if (res.Errors?.length) {
          throw new Error(`Archive delete failed for ${res.Errors.length} objects: ${res.Errors[0]?.Message}`);
        }
      }
    },
    async downloadUrl(key, seconds, filename) {
      return getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          ResponseContentDisposition: `attachment; filename="${filename.replace(/"/g, "")}"`,
        }),
        { expiresIn: seconds },
      );
    },
    async get(key) {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return res.Body ? Buffer.from(await res.Body.transformToByteArray()) : null;
      } catch (err) {
        if ((err as { name?: string }).name === "NoSuchKey") return null;
        throw err;
      }
    },
  };
}

/** In-memory archive for tests. */
export class MemoryArchiveStore implements ArchiveStore {
  readonly description = "memory";
  readonly objects = new Map<string, { body: Buffer; contentType: string; lockUntil: Date | null }>();
  constructor(readonly locking = false) {}
  async put(key: string, body: Readable | Buffer, opts: { contentType: string; lockUntil?: Date | null }) {
    const chunks: Buffer[] = [];
    if (Buffer.isBuffer(body)) chunks.push(body);
    else for await (const chunk of body) chunks.push(Buffer.from(chunk));
    this.objects.set(key, {
      body: Buffer.concat(chunks),
      contentType: opts.contentType,
      lockUntil: opts.lockUntil ?? null,
    });
  }
  async remove(keys: string[]) {
    for (const key of keys) this.objects.delete(key);
  }
  async downloadUrl(key: string, seconds: number) {
    return `memory://${key}?expires=${seconds}`;
  }
  async get(key: string) {
    return this.objects.get(key)?.body ?? null;
  }
}

export const bufferStream = (body: Buffer) => Readable.from([body]);
