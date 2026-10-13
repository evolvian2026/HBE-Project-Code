import { toCsv, utcToZonedLocal, type CsvCell } from "@hbe/core";
import { actorLabel, AUDIT_TIMEZONE, changedFields, loadAudit, type AuditFilters } from "./audit";
import type { createSupabaseServerClient } from "./supabase/server";

/** The most rows one export holds; narrow the filters for more. */
const MAX_ROWS = 20_000;
const BATCH = 1000;

/** The audit rows matching the filters as CSV (newest first), read under RLS. */
export async function auditCsv(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  institutionId: string | null,
  filters: AuditFilters,
  filename: string,
): Promise<Response> {
  const table: CsvCell[][] = [
    [`at (${AUDIT_TIMEZONE})`, "by", "change", "what", "id", "changed fields", "before", "after"],
  ];
  let before = filters.before;
  for (let n = 0; n < MAX_ROWS; n += BATCH) {
    const { rows, actors } = await loadAudit(supabase, institutionId, { ...filters, before }, BATCH);
    for (const r of rows) {
      table.push([
        utcToZonedLocal(new Date(r.at), AUDIT_TIMEZONE).replace("T", " "),
        actorLabel(r, actors),
        r.action,
        r.entity,
        r.entity_id,
        changedFields(r).join(" "),
        r.before ? JSON.stringify(r.before) : null,
        r.after ? JSON.stringify(r.after) : null,
      ]);
    }
    if (rows.length < BATCH) break;
    before = rows.at(-1)!.id;
  }
  return new Response("﻿" + toCsv(table), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}
