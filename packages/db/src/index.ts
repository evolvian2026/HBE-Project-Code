import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import pg from "pg";
import type { Database } from "./types.ts";

export * from "./types.ts";
export { sql };
export type Db = Kysely<Database>;
export type Tx = Transaction<Database>;

const INT8_OID = 20;

/**
 * int8 columns hold GitHub ids and counts, all far below 2^53, so they are returned as
 * numbers. Anything larger fails loudly instead of silently losing precision.
 */
function parseInt8(value: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError(`int8 value ${value} exceeds Number.MAX_SAFE_INTEGER`);
  return n;
}

export interface DbOptions {
  connectionString: string;
  max: number;
  applicationName?: string;
}

/**
 * Server-side database access. Connects as the table owner, so RLS does not apply:
 * every query must be scoped by institution and checked with @hbe/core permissions.
 */
export function createDb({ connectionString, max, applicationName = "hbe" }: DbOptions): Db {
  const pool = new pg.Pool({
    connectionString,
    max,
    application_name: applicationName,
    types: {
      getTypeParser: ((oid: number, format?: string) =>
        oid === INT8_OID ? parseInt8 : pg.types.getTypeParser(oid, format as "text")) as typeof pg.types.getTypeParser,
    },
  });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

/**
 * Runs `fn` in a transaction with `hbe.actor_id` set, so audit triggers record who acted.
 */
export async function withActor<T>(db: Db, actorId: string | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (tx) => {
    if (actorId) await sql`select set_config('hbe.actor_id', ${actorId}, true)`.execute(tx);
    return fn(tx);
  });
}

export async function pingDb(db: Db): Promise<void> {
  await sql`select 1`.execute(db);
}
