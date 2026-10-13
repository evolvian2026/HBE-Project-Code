import { zonedLocalToUtc } from "@hbe/core";
import type { createSupabaseServerClient } from "./supabase/server";

type Supabase = Awaited<ReturnType<typeof createSupabaseServerClient>>;

/** Times on audit pages are shown, and filtered by date, in the platform's time zone. */
export const AUDIT_TIMEZONE = "Asia/Singapore";

/** The audited tables, by what people call them. */
export const AUDITED: Record<string, string> = {
  institutions: "Institution",
  institution_memberships: "Membership",
  invitations: "Invitation",
  user_roles: "Platform role",
  course_memberships: "Course membership",
  teams: "Team",
  team_members: "Team member",
  assignments: "Assignment",
  assignment_extensions: "Extension",
  rubric_scores: "Rubric score",
  feedback: "Feedback",
  grades: "Grade",
  regrade_requests: "Regrade request",
  review_comments: "Code comment",
  commit_claims: "Commit claim",
  commit_author_aliases: "Confirmed git email",
  run_batches: "Bulk re-run",
  stack_profiles: "Stack profile",
  grader_suites: "Test suite",
  github_installations: "GitHub installation",
  lms_connections: "LMS connection",
  lms_course_links: "LMS course link",
  lms_user_links: "LMS user link",
  lms_assignment_links: "LMS assignment link",
  platform_settings: "Platform setting",
};

export interface AuditFilters {
  entity?: string;
  action?: "insert" | "update" | "delete";
  /** Part of the actor's email. */
  actor?: string;
  /** Dates (YYYY-MM-DD) in AUDIT_TIMEZONE, both included. */
  from?: string;
  to?: string;
  /** Rows older than this id (paging). */
  before?: number;
}

export interface AuditRow {
  id: number;
  at: string;
  actor_id: string | null;
  action: "insert" | "update" | "delete";
  entity: string;
  entity_id: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Filters from a page's query string (anything unexpected is ignored). */
export function auditFilters(query: Record<string, string | undefined>): AuditFilters {
  const f: AuditFilters = {};
  if (query.entity && query.entity in AUDITED) f.entity = query.entity;
  if (query.action === "insert" || query.action === "update" || query.action === "delete") f.action = query.action;
  if (query.actor?.trim()) f.actor = query.actor.trim().slice(0, 200);
  if (query.from && DATE.test(query.from)) f.from = query.from;
  if (query.to && DATE.test(query.to)) f.to = query.to;
  const before = Number(query.before);
  if (Number.isSafeInteger(before) && before > 0) f.before = before;
  return f;
}

/** The query string for these filters (paging aside). */
export function auditQueryString(f: AuditFilters, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams();
  for (const k of ["entity", "action", "actor", "from", "to"] as const) if (f[k]) params.set(k, String(f[k]));
  for (const [k, v] of Object.entries(extra)) params.set(k, v);
  const s = params.toString();
  return s ? `?${s}` : "";
}

/**
 * A page of audit rows (newest first), read under RLS: an institution's admins get theirs,
 * super admins the platform's own (no institution). `null` scope means platform rows.
 */
export async function loadAudit(
  supabase: Supabase,
  institutionId: string | null,
  f: AuditFilters,
  limit: number,
): Promise<{ rows: AuditRow[]; actors: Map<string, string>; noSuchActor: boolean }> {
  let actorIds: string[] | null = null;
  if (f.actor) {
    const { data } = await supabase
      .from("profiles")
      .select("id")
      .ilike("email", `%${f.actor.replace(/[%_]/g, "")}%`)
      .limit(50);
    actorIds = (data ?? []).map((p) => p.id);
    if (!actorIds.length) return { rows: [], actors: new Map(), noSuchActor: true };
  }
  let q = supabase
    .from("audit_logs")
    .select("id, at, actor_id, action, entity, entity_id, before, after")
    .order("id", { ascending: false })
    .limit(limit);
  q = institutionId ? q.eq("institution_id", institutionId) : q.is("institution_id", null);
  if (f.entity) q = q.eq("entity", f.entity);
  if (f.action) q = q.eq("action", f.action);
  if (actorIds) q = q.in("actor_id", actorIds);
  if (f.from) q = q.gte("at", zonedLocalToUtc(`${f.from}T00:00`, AUDIT_TIMEZONE).toISOString());
  if (f.to)
    q = q.lt("at", new Date(zonedLocalToUtc(`${f.to}T00:00`, AUDIT_TIMEZONE).getTime() + 86_400_000).toISOString());
  if (f.before) q = q.lt("id", f.before);
  const { data } = await q;
  const rows = (data ?? []) as AuditRow[];

  const ids = [...new Set(rows.map((r) => r.actor_id).filter((id): id is string => Boolean(id)))];
  const { data: people } = ids.length
    ? await supabase.from("profiles").select("id, email, full_name").in("id", ids)
    : { data: [] };
  const actors = new Map(
    ((people ?? []) as { id: string; email: string | null; full_name: string | null }[]).map((p) => [
      p.id,
      p.full_name && p.email ? `${p.full_name} <${p.email}>` : (p.email ?? p.full_name ?? p.id),
    ]),
  );
  return { rows, actors, noSuchActor: false };
}

const IGNORED = new Set(["updated_at"]);

/** The fields an update changed (an insert or delete: none, the whole row is the change). */
export function changedFields(row: Pick<AuditRow, "action" | "before" | "after">): string[] {
  if (row.action !== "update" || !row.before || !row.after) return [];
  const keys = new Set([...Object.keys(row.before), ...Object.keys(row.after)]);
  return [...keys].filter(
    (k) => !IGNORED.has(k) && JSON.stringify(row.before![k] ?? null) !== JSON.stringify(row.after![k] ?? null),
  );
}

/** Who did it: a person, or the platform itself (a job, or an automatic change). */
export const actorLabel = (row: Pick<AuditRow, "actor_id">, actors: Map<string, string>) =>
  row.actor_id
    ? (actors.get(row.actor_id) ?? `someone outside the institution (${row.actor_id.slice(0, 8)})`)
    : "the platform";
