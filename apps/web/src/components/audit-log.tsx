import { formatInZone } from "@hbe/core";
import Link from "next/link";
import {
  actorLabel,
  AUDIT_TIMEZONE,
  AUDITED,
  auditQueryString,
  changedFields,
  type AuditFilters,
  type AuditRow,
} from "@/lib/audit";
import { Badge, Button, Card, EmptyState } from "./ui";

const ACTION = { insert: "added", update: "changed", delete: "removed" } as const;
const ACTION_TONE = { insert: "success", update: "accent", delete: "danger" } as const;
const selectClass = "mt-1 block w-full rounded-md border border-border bg-surface px-3 py-2 text-sm";

const show = (v: unknown) => (v === null || v === undefined ? "–" : typeof v === "string" ? v : JSON.stringify(v));

/** The audit log with its filters (a GET form), a CSV export of the same filters, and paging. */
export function AuditLogView({
  basePath,
  filters,
  rows,
  actors,
  pageSize,
  noSuchActor,
}: {
  basePath: string;
  filters: AuditFilters;
  rows: AuditRow[];
  actors: Map<string, string>;
  pageSize: number;
  noSuchActor: boolean;
}) {
  const page = rows.slice(0, pageSize);
  const more = rows.length > pageSize;
  return (
    <Card
      title="Audit log"
      description={`Every change to people, roles, grades, settings and connections: who, when, and what it was before and after. Times in ${AUDIT_TIMEZONE}.`}
    >
      <form
        method="get"
        action={basePath}
        className="mb-4 grid gap-3 text-sm sm:grid-cols-6"
        aria-label="Filter the audit log"
      >
        <label className="sm:col-span-2">
          <span className="font-medium">What</span>
          <select name="entity" defaultValue={filters.entity ?? ""} className={selectClass}>
            <option value="">Everything</option>
            {Object.entries(AUDITED).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="font-medium">Change</span>
          <select name="action" defaultValue={filters.action ?? ""} className={selectClass}>
            <option value="">Any</option>
            <option value="insert">Added</option>
            <option value="update">Changed</option>
            <option value="delete">Removed</option>
          </select>
        </label>
        <label className="sm:col-span-3">
          <span className="font-medium">By (email)</span>
          <input name="actor" defaultValue={filters.actor ?? ""} className={selectClass} placeholder="ada@" />
        </label>
        <label className="sm:col-span-2">
          <span className="font-medium">From</span>
          <input type="date" name="from" defaultValue={filters.from ?? ""} className={selectClass} />
        </label>
        <label className="sm:col-span-2">
          <span className="font-medium">To</span>
          <input type="date" name="to" defaultValue={filters.to ?? ""} className={selectClass} />
        </label>
        <div className="flex items-end gap-2 sm:col-span-2">
          <Button type="submit" variant="secondary">
            Filter
          </Button>
          {/* A plain link: the export is a download, not a page to prefetch. */}
          <a href={`${basePath}/export${auditQueryString(filters)}`} className="py-2 link">
            Export CSV
          </a>
        </div>
      </form>

      {page.length === 0 ? (
        <EmptyState title={noSuchActor ? "No one with that email" : "Nothing recorded for these filters"} />
      ) : (
        <ul className="divide-y divide-border text-sm" data-testid="audit-rows">
          {page.map((r) => {
            const fields = changedFields(r);
            return (
              <li key={r.id} className="py-2.5">
                <details>
                  <summary className="flex cursor-pointer flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="tabular-nums text-muted">{formatInZone(r.at, AUDIT_TIMEZONE)}</span>
                    <Badge tone={ACTION_TONE[r.action]}>
                      {AUDITED[r.entity] ?? r.entity} {ACTION[r.action]}
                    </Badge>
                    <span>{actorLabel(r, actors)}</span>
                    {fields.length > 0 && <span className="text-xs text-muted">{fields.join(", ")}</span>}
                  </summary>
                  <div className="mt-2 overflow-x-auto rounded-md border border-border p-2 text-xs">
                    <p className="mb-1 font-mono text-muted">
                      {r.entity} {r.entity_id}
                    </p>
                    <table className="w-full">
                      <thead className="text-left text-muted">
                        <tr>
                          <th className="pr-3 font-medium">Field</th>
                          <th className="pr-3 font-medium">Before</th>
                          <th className="font-medium">After</th>
                        </tr>
                      </thead>
                      <tbody className="font-mono">
                        {(fields.length ? fields : Object.keys(r.after ?? r.before ?? {})).map((k) => (
                          <tr key={k} className="align-top">
                            <td className="pr-3">{k}</td>
                            <td className="max-w-xs break-all pr-3">{show(r.before?.[k])}</td>
                            <td className="max-w-xs break-all">{show(r.after?.[k])}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              </li>
            );
          })}
        </ul>
      )}
      {more && (
        <div className="mt-4">
          <Link
            href={`${basePath}${auditQueryString(filters, { before: String(page.at(-1)!.id) })}`}
            className="text-sm link"
          >
            Older entries →
          </Link>
        </div>
      )}
    </Card>
  );
}
