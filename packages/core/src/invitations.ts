import { parseCsv } from "./csv.ts";
import type { InstitutionRole } from "./permissions.ts";

export type CourseRole = "instructor" | "ta" | "student";

const INSTITUTION_ROLES: readonly InstitutionRole[] = ["admin", "teacher", "student"];
const COURSE_ROLES: readonly CourseRole[] = ["instructor", "ta", "student"];
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
export const MAX_IMPORT_ROWS = 1000;

export interface InviteRow {
  /** 1-based line number in the source (header is line 1 for CSV). */
  line: number;
  email?: string;
  githubLogin?: string;
  role: string;
  courseCode?: string;
  courseTerm?: string;
  courseRole?: string;
  /** Set when the course is already known (inviting from a course page). */
  courseId?: string;
}

export interface PlanContext {
  members: { userId: string; email: string | null; githubLogin: string | null; status: "active" | "deactivated" }[];
  pendingInvitations: { email: string | null; githubLogin: string | null; courseId: string | null }[];
  courses: { id: string; code: string; term: string; archived: boolean }[];
  courseMembers: { courseId: string; userId: string }[];
}

export interface PlannedInvitation {
  email: string | null;
  github_login: string | null;
  role: InstitutionRole;
  course_id: string | null;
  course_role: CourseRole | null;
}

export interface InvitationPlan {
  invitations: PlannedInvitation[];
  courseMemberships: { course_id: string; user_id: string; role: CourseRole }[];
  skipped: { line: number; who: string; reason: string }[];
  errors: { line: number; message: string }[];
}

const defaultCourseRole = (role: InstitutionRole): CourseRole => (role === "student" ? "student" : "instructor");
const norm = (v: string | undefined | null) => (v ?? "").trim().toLowerCase();

/** Reads an invitation CSV. Header names are case-insensitive; `role` and `email` or `github_login` are required. */
export function parseInviteCsv(text: string): { rows: InviteRow[]; errors: { line: number; message: string }[] } {
  const table = parseCsv(text);
  if (table.length === 0) return { rows: [], errors: [{ line: 1, message: "The file is empty" }] };

  const header = table[0]!.map((h) =>
    h
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_"),
  );
  const col = (name: string) => header.indexOf(name);
  const missing = ["role"].filter((h) => col(h) < 0);
  if (col("email") < 0 && col("github_login") < 0) missing.push("email or github_login");
  if (missing.length) return { rows: [], errors: [{ line: 1, message: `Missing column: ${missing.join(", ")}` }] };
  if (table.length - 1 > MAX_IMPORT_ROWS) {
    return { rows: [], errors: [{ line: 1, message: `At most ${MAX_IMPORT_ROWS} rows per import` }] };
  }

  const get = (r: string[], name: string) => {
    const i = col(name);
    const v = i >= 0 ? r[i]?.trim() : undefined;
    return v ? v : undefined;
  };
  return {
    rows: table.slice(1).map((r, i) => ({
      line: i + 2,
      email: get(r, "email"),
      githubLogin: get(r, "github_login"),
      role: get(r, "role") ?? "",
      courseCode: get(r, "course_code"),
      courseTerm: get(r, "course_term"),
      courseRole: get(r, "course_role"),
    })),
    errors: [],
  };
}

/**
 * Decides what to do with each requested invitation: invite, enrol an existing member in a
 * course, skip (already done), or report an error. Pure, so it is unit-tested; the caller
 * executes the plan with the user's own (RLS-checked) privileges.
 */
export function planInvitations(rows: InviteRow[], ctx: PlanContext): InvitationPlan {
  const plan: InvitationPlan = { invitations: [], courseMemberships: [], skipped: [], errors: [] };
  const seen = new Set<string>();

  for (const row of rows) {
    const email = norm(row.email) || null;
    const login = (row.githubLogin ?? "").trim().replace(/^@/, "") || null;
    const who = email ?? (login ? `@${login}` : `line ${row.line}`);
    const fail = (message: string) => plan.errors.push({ line: row.line, message: `${who}: ${message}` });

    if (!email && !login) {
      fail("needs an email or a GitHub username");
      continue;
    }
    if (email && !EMAIL.test(email)) {
      fail("is not a valid email address");
      continue;
    }
    if (login && !GITHUB_LOGIN.test(login)) {
      fail("is not a valid GitHub username");
      continue;
    }
    const role = norm(row.role) as InstitutionRole;
    if (!INSTITUTION_ROLES.includes(role)) {
      fail(`role must be one of ${INSTITUTION_ROLES.join(", ")}`);
      continue;
    }

    let courseId: string | null = row.courseId ?? null;
    if (!courseId && row.courseCode) {
      const matches = ctx.courses.filter(
        (c) =>
          !c.archived &&
          norm(c.code) === norm(row.courseCode) &&
          (!row.courseTerm || norm(c.term) === norm(row.courseTerm)),
      );
      if (matches.length === 0) {
        fail(`no active course ${row.courseCode}${row.courseTerm ? ` (${row.courseTerm})` : ""}`);
        continue;
      }
      if (matches.length > 1) {
        fail(`course code ${row.courseCode} exists in several terms; add a course_term column`);
        continue;
      }
      courseId = matches[0]!.id;
    }
    let courseRole: CourseRole | null = null;
    if (courseId) {
      courseRole = row.courseRole ? (norm(row.courseRole) as CourseRole) : defaultCourseRole(role);
      if (!COURSE_ROLES.includes(courseRole)) {
        fail(`course role must be one of ${COURSE_ROLES.join(", ")}`);
        continue;
      }
    }

    const key = `${email ?? ""}|${norm(login)}|${courseId ?? ""}`;
    if (seen.has(key)) {
      plan.skipped.push({ line: row.line, who, reason: "duplicate row" });
      continue;
    }
    seen.add(key);

    const member = ctx.members.find(
      (m) => (email && norm(m.email) === email) || (login && norm(m.githubLogin) === norm(login)),
    );
    if (member) {
      if (member.status !== "active") {
        fail("is a deactivated member; reactivate them on the Members page first");
      } else if (!courseId) {
        plan.skipped.push({ line: row.line, who, reason: "already a member" });
      } else if (ctx.courseMembers.some((cm) => cm.courseId === courseId && cm.userId === member.userId)) {
        plan.skipped.push({ line: row.line, who, reason: "already in the course" });
      } else {
        plan.courseMemberships.push({ course_id: courseId, user_id: member.userId, role: courseRole! });
      }
      continue;
    }

    const alreadyInvited = ctx.pendingInvitations.some(
      (inv) =>
        (inv.courseId ?? null) === courseId &&
        ((email && norm(inv.email) === email) || (login && norm(inv.githubLogin) === norm(login))),
    );
    if (alreadyInvited) {
      plan.skipped.push({ line: row.line, who, reason: "already invited" });
      continue;
    }

    plan.invitations.push({ email, github_login: login, role, course_id: courseId, course_role: courseRole });
  }
  return plan;
}

export const INVITE_CSV_TEMPLATE =
  "email,github_login,role,course_code,course_term,course_role\n" +
  "ada@example.edu,,student,CS101,2026-T1,student\n" +
  ",octocat,student,CS101,2026-T1,student\n" +
  "grace@example.edu,,teacher,CS101,2026-T1,instructor\n";
