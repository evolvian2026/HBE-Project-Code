import {
  ClassroomClient,
  courseRoleFromLti,
  GOOGLE_ENDPOINTS,
  GoogleError,
  type GoogleEndpoints,
  type LtiServices,
} from "@hbe/lms";
import type { Db } from "@hbe/db";
import type { JobQueue } from "@hbe/queue";
import type { Settings } from "@hbe/settings";
import { openSecret } from "../secrets.ts";
import { servicesFor } from "./services.ts";

export interface LmsDeps {
  db: Db;
  settings: Settings;
  queue?: JobQueue;
}

/** An assignment's column in one LMS gradebook (an lms_assignment_links row). */
export interface Column {
  id: string;
  score_maximum: number;
  lineitem_url: string | null;
  classroom_coursework_id: string | null;
}

export interface RosterMember {
  userId: string;
  email: string | null;
  name: string | null;
  learner: boolean;
  active: boolean;
}

/**
 * One LMS course's gradebook and roster, whatever the LMS: LTI Advantage (AGS and NRPS) or
 * Google Classroom (coursework and rosters through the API, as the teacher who linked it).
 */
export interface Gradebook {
  linkId: string;
  institutionId: string;
  connectionId: string;
  courseId: string | null;
  kind: "lti" | "classroom";
  hasRoster: boolean;
  /** The assignment's column, made if the LMS lets the platform make it; else why not. */
  column(assignment: { id: string; title: string }): Promise<Column | { skip: string }>;
  postScore(
    column: Column,
    lmsUserId: string,
    score: { given: number; comment: string; timestamp: Date },
  ): Promise<void>;
  /** What the gradebook shows, per LMS user (on the column's scale). */
  results(column: Column): Promise<Map<string, number>>;
  members(): Promise<RosterMember[]>;
}

export function googleEndpoints(settings: Settings): GoogleEndpoints {
  const fake = settings.env.GOOGLE_FAKE_URL;
  return fake ? { authUrl: `${fake}/auth`, tokenUrl: `${fake}/token`, apiUrl: fake } : GOOGLE_ENDPOINTS;
}

export function googleConfigured(settings: Settings): boolean {
  return Boolean(settings.env.GOOGLE_OAUTH_CLIENT_ID && settings.env.GOOGLE_OAUTH_CLIENT_SECRET);
}

/**
 * Runs `fn` with a teacher's Classroom client (from their stored, encrypted refresh token). A
 * consent Google reports as revoked is recorded on the account, so the course page asks the
 * teacher to connect again.
 */
export async function withClassroom<T>(
  deps: LmsDeps,
  googleAccountId: string | null,
  fn: (client: ClassroomClient) => Promise<T>,
): Promise<T> {
  const { db, settings } = deps;
  const account = googleAccountId
    ? await db
        .selectFrom("google_accounts")
        .select(["id", "refresh_token_encrypted", "revoked_at"])
        .where("id", "=", googleAccountId)
        .executeTakeFirst()
    : undefined;
  if (!account || account.revoked_at) {
    throw new GoogleError(
      "auth_revoked",
      "The Google account this class was linked with is no longer connected. Its teacher should connect Google again.",
    );
  }
  if (!googleConfigured(settings)) throw new GoogleError("auth_failed", "Google sign-in isn't set up on the platform.");
  const client = new ClassroomClient(googleEndpoints(settings), {
    clientId: settings.env.GOOGLE_OAUTH_CLIENT_ID!,
    clientSecret: settings.env.GOOGLE_OAUTH_CLIENT_SECRET!,
    refreshToken: openSecret(settings, account.refresh_token_encrypted),
  });
  try {
    return await fn(client);
  } catch (err) {
    if (err instanceof GoogleError && err.code === "auth_revoked") {
      await db
        .updateTable("google_accounts")
        .set({ revoked_at: new Date(), last_error: err.message })
        .where("id", "=", account.id)
        .execute();
    }
    throw err;
  }
}

async function columnRow(db: Db, linkId: string, assignmentId: string) {
  const row = await db
    .selectFrom("lms_assignment_links")
    .select(["id", "score_maximum", "lineitem_url", "classroom_coursework_id"])
    .where("lms_course_link_id", "=", linkId)
    .where("assignment_id", "=", assignmentId)
    .executeTakeFirst();
  return row ? { ...row, score_maximum: Number(row.score_maximum) } : null;
}

/**
 * The gradebook column of an assignment in an LMS course: the one recorded (from deep linking
 * or a launch), else the one the tool made earlier (found by its resourceId), else a new one.
 */
export async function ensureLineItem(
  db: Db,
  services: LtiServices,
  link: { id: string; institution_id: string; ags_lineitems_url: string | null },
  assignment: { id: string; title: string },
): Promise<Column> {
  const existing = await columnRow(db, link.id, assignment.id);
  if (existing?.lineitem_url) return existing;
  const item =
    (await services.findLineItem(link.ags_lineitems_url!, assignment.id)) ??
    (await services.createLineItem(link.ags_lineitems_url!, {
      label: assignment.title,
      scoreMaximum: 100,
      resourceId: assignment.id,
      tag: "hbe-grade",
    }));
  const max = String(item.scoreMaximum || 100);
  const row = await db
    .insertInto("lms_assignment_links")
    .values({
      institution_id: link.institution_id,
      assignment_id: assignment.id,
      lms_course_link_id: link.id,
      lineitem_url: item.id,
      score_maximum: max,
    })
    .onConflict((oc) =>
      oc.columns(["lms_course_link_id", "assignment_id"]).doUpdateSet({ lineitem_url: item.id, score_maximum: max }),
    )
    .returning(["id", "score_maximum", "lineitem_url", "classroom_coursework_id"])
    .executeTakeFirstOrThrow();
  return { ...row, score_maximum: Number(row.score_maximum) };
}

const linkColumns = [
  "l.id",
  "l.institution_id",
  "l.course_id",
  "l.context_id",
  "l.ags_lineitems_url",
  "l.nrps_url",
  "l.google_account_id",
  "c.id as connection_id",
  "c.type",
  "c.issuer",
  "c.client_id",
  "c.deployment_ids",
  "c.auth_login_url",
  "c.auth_token_url",
  "c.jwks_url",
] as const;

type LinkRow = {
  id: string;
  institution_id: string;
  course_id: string | null;
  context_id: string;
  ags_lineitems_url: string | null;
  nrps_url: string | null;
  google_account_id: string | null;
  connection_id: string;
  type: string;
  issuer: string | null;
  client_id: string | null;
  deployment_ids: string[];
  auth_login_url: string | null;
  auth_token_url: string | null;
  jwks_url: string | null;
};

function ltiGradebook(deps: LmsDeps, l: LinkRow): Gradebook {
  const services = () => servicesFor(deps.settings, { ...l, id: l.connection_id });
  return {
    linkId: l.id,
    institutionId: l.institution_id,
    connectionId: l.connection_id,
    courseId: l.course_id,
    kind: "lti",
    hasRoster: Boolean(l.nrps_url),
    async column(assignment) {
      if (!l.ags_lineitems_url) return { skip: "This LMS course doesn't accept grades from the platform." };
      return ensureLineItem(deps.db, await services(), l, assignment);
    },
    async postScore(column, lmsUserId, score) {
      await (
        await services()
      ).postScore(column.lineitem_url!, {
        userId: lmsUserId,
        scoreGiven: score.given,
        scoreMaximum: column.score_maximum,
        comment: score.comment,
        timestamp: score.timestamp.toISOString(),
        activityProgress: "Completed",
        gradingProgress: "FullyGraded",
      });
    },
    async results(column) {
      const out = new Map<string, number>();
      for (const r of await (await services()).results(column.lineitem_url!)) {
        if (r.resultScore !== null) {
          out.set(r.userId, (r.resultScore / (r.resultMaximum || column.score_maximum)) * column.score_maximum);
        }
      }
      return out;
    },
    async members() {
      return (await (await services()).members(l.nrps_url!)).map((m) => ({
        userId: m.userId,
        email: m.email,
        name: m.name,
        learner: courseRoleFromLti(m.roles) === "student",
        active: m.status === "Active",
      }));
    },
  };
}

function classroomGradebook(deps: LmsDeps, l: LinkRow): Gradebook {
  const classroom = <T>(fn: (client: ClassroomClient) => Promise<T>) => withClassroom(deps, l.google_account_id, fn);
  return {
    linkId: l.id,
    institutionId: l.institution_id,
    connectionId: l.connection_id,
    courseId: l.course_id,
    kind: "classroom",
    hasRoster: true,
    async column(assignment) {
      const row = await columnRow(deps.db, l.id, assignment.id);
      return row?.classroom_coursework_id
        ? row
        : { skip: "The assignment hasn't been posted to Google Classroom yet (Post to Google Classroom)." };
    },
    postScore: (column, lmsUserId, score) =>
      classroom(async (c) => {
        const [submission] = await c.submissions(l.context_id, column.classroom_coursework_id!, lmsUserId);
        if (!submission) throw new GoogleError("not_found", "Google Classroom has no submission for this student.");
        await c.grade(l.context_id, column.classroom_coursework_id!, submission.id, score.given);
      }),
    results: (column) =>
      classroom(async (c) => {
        const out = new Map<string, number>();
        for (const s of await c.submissions(l.context_id, column.classroom_coursework_id!)) {
          if (s.assignedGrade !== null) out.set(s.userId, s.assignedGrade);
        }
        return out;
      }),
    members: () =>
      classroom(async (c) =>
        (await c.students(l.context_id)).map((s) => ({
          userId: s.userId,
          email: s.email,
          name: s.name,
          learner: true,
          active: true,
        })),
      ),
  };
}

const toGradebook = (deps: LmsDeps, l: LinkRow) =>
  l.type === "google_classroom" ? classroomGradebook(deps, l) : ltiGradebook(deps, l);

/** The gradebooks linked to a platform course (active connections that take grades). */
export async function gradebooksOfCourse(deps: LmsDeps, courseId: string): Promise<Gradebook[]> {
  const links = await deps.db
    .selectFrom("lms_course_links as l")
    .innerJoin("lms_connections as c", "c.id", "l.lms_connection_id")
    .select(linkColumns)
    .where("l.course_id", "=", courseId)
    .where("c.status", "=", "active")
    .where((eb) => eb.or([eb("l.ags_lineitems_url", "is not", null), eb("c.type", "=", "google_classroom")]))
    .execute();
  return links.map((l) => toGradebook(deps, l));
}

/** One LMS course's gradebook, if its connection and institution are active. */
export async function gradebookOf(deps: LmsDeps, linkId: string): Promise<Gradebook | null> {
  const l = await deps.db
    .selectFrom("lms_course_links as l")
    .innerJoin("lms_connections as c", "c.id", "l.lms_connection_id")
    .innerJoin("institutions as i", "i.id", "l.institution_id")
    .select(linkColumns)
    .where("l.id", "=", linkId)
    .where("c.status", "=", "active")
    .where("i.status", "=", "active")
    .executeTakeFirst();
  return l ? toGradebook(deps, l) : null;
}
