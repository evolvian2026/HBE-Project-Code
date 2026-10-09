import { randomBytes } from "node:crypto";
import { authorize, ForbiddenError, roleIn } from "@hbe/core";
import { withActor } from "@hbe/db";
import { authorizationUrl, exchangeCode, GoogleError, pkce } from "@hbe/lms";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiDeps } from "../app.ts";
import { authenticate } from "../auth.ts";
import { conflict, HttpError, notFound } from "../errors.ts";
import { classroomConnection, postToClassroom } from "../lti/classroom.ts";
import { googleConfigured, googleEndpoints, withClassroom } from "../lti/gradebook.ts";
import { sealSecret } from "../secrets.ts";
import { courseRoleOf } from "./lms.ts";

const STATE_TTL_MS = 10 * 60_000;
const uuid = z.string().uuid();
const safeNext = (v: string | undefined) =>
  v && v.startsWith("/") && !v.startsWith("//") && !v.includes("\\") ? v : "/";

/**
 * Google Classroom (§13): admins turn it on for the institution; teachers connect their Google
 * account (OAuth with PKCE; the refresh token is stored encrypted), link Classroom classes to
 * their courses and post assignments there as coursework.
 */
export async function googleRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const { db, verifier, settings, queue } = deps;
  const callbackUrl = `${settings.env.API_URL.replace(/\/$/, "")}/v1/oauth/google/callback`;
  const notSetUp = () =>
    new HttpError(
      503,
      "google_not_configured",
      "Google sign-in isn't set up on the platform yet. Ask the platform team.",
    );

  /** An admin turns Google Classroom on or off for the institution. */
  app.put<{ Params: { institutionId: string } }>("/v1/institutions/:institutionId/google-classroom", async (req) => {
    const actor = await authenticate(req, db, verifier);
    const institutionId = uuid.parse(req.params.institutionId);
    authorize(actor, "manageInstitution", institutionId);
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    if (enabled && !googleConfigured(settings)) throw notSetUp();
    const status = enabled ? ("active" as const) : ("disabled" as const);
    const existing = await classroomConnection(db, institutionId);
    await withActor(db, actor.userId, async (tx) => {
      if (existing) await tx.updateTable("lms_connections").set({ status }).where("id", "=", existing.id).execute();
      else
        await tx
          .insertInto("lms_connections")
          .values({
            institution_id: institutionId,
            type: "google_classroom",
            name: "Google Classroom",
            status,
            created_by: actor.userId,
          })
          .execute();
    });
    return { enabled };
  });

  /** A teacher starts connecting their Google account; the browser goes to the returned URL. */
  app.post<{ Params: { institutionId: string } }>(
    "/v1/institutions/:institutionId/google/connect",
    async (req, reply) => {
      const actor = await authenticate(req, db, verifier);
      const institutionId = uuid.parse(req.params.institutionId);
      const role = roleIn(actor, institutionId);
      if (
        (role !== "teacher" && role !== "admin") ||
        actor.memberships.get(institutionId)?.institutionStatus !== "active"
      ) {
        throw new ForbiddenError("Only teachers and admins connect Google Classroom.");
      }
      if (!googleConfigured(settings)) throw notSetUp();
      if ((await classroomConnection(db, institutionId))?.status !== "active") {
        throw conflict("classroom_off", "Google Classroom isn't turned on for your institution. Ask an admin.");
      }
      const { next } = z.object({ next: z.string().max(500).optional() }).parse(req.body ?? {});
      const { verifier: codeVerifier, challenge } = pkce();
      const state = randomBytes(24).toString("base64url");
      await db
        .insertInto("google_oauth_states")
        .values({
          state,
          institution_id: institutionId,
          profile_id: actor.userId,
          code_verifier: codeVerifier,
          next: safeNext(next),
        })
        .execute();
      const profile = await db.selectFrom("profiles").select("email").where("id", "=", actor.userId).executeTakeFirst();
      return reply.code(201).send({
        url: authorizationUrl(googleEndpoints(settings), {
          clientId: settings.env.GOOGLE_OAUTH_CLIENT_ID!,
          redirectUri: callbackUrl,
          state,
          codeChallenge: challenge,
          loginHint: profile?.email,
        }),
      });
    },
  );

  /** Google sends the browser back here with a code (or an error). */
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    "/v1/oauth/google/callback",
    async (req, reply) => {
      const back = (next: string, params: Record<string, string>) => {
        const url = new URL(next, settings.env.APP_URL);
        for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
        return reply.redirect(url.toString(), 302);
      };
      const state = await db
        .updateTable("google_oauth_states")
        .set({ consumed_at: new Date() })
        .where(
          "state",
          "=",
          z
            .string()
            .max(200)
            .parse(req.query.state ?? ""),
        )
        .where("consumed_at", "is", null)
        .where("created_at", ">", new Date(Date.now() - STATE_TTL_MS))
        .returning(["institution_id", "profile_id", "code_verifier", "next"])
        .executeTakeFirst();
      if (!state) return back("/", { google_error: "The Google sign-in expired. Try connecting again." });
      if (req.query.error || !req.query.code) {
        return back(state.next, {
          google_error:
            req.query.error === "access_denied" ? "Google access wasn't granted." : "Google sign-in failed.",
        });
      }
      if (!googleConfigured(settings)) return back(state.next, { google_error: "Google sign-in isn't set up." });
      try {
        const grant = await exchangeCode(googleEndpoints(settings), {
          clientId: settings.env.GOOGLE_OAUTH_CLIENT_ID!,
          clientSecret: settings.env.GOOGLE_OAUTH_CLIENT_SECRET!,
          code: req.query.code,
          redirectUri: callbackUrl,
          codeVerifier: state.code_verifier,
        });
        const values = {
          google_user_id: grant.googleUserId,
          email: grant.email,
          refresh_token_encrypted: sealSecret(settings, grant.refreshToken),
          scopes: grant.scopes,
          connected_at: new Date(),
          revoked_at: null,
          last_error: null,
        };
        await db
          .insertInto("google_accounts")
          .values({ institution_id: state.institution_id, profile_id: state.profile_id, ...values })
          .onConflict((oc) => oc.columns(["institution_id", "profile_id"]).doUpdateSet(values))
          .execute();
        return back(state.next, { google: "connected" });
      } catch (err) {
        req.log.warn({ err: (err as Error).message }, "Google connection failed");
        return back(state.next, {
          google_error: err instanceof GoogleError ? err.message : "Google sign-in failed. Try again.",
        });
      }
    },
  );

  /** A teacher disconnects their Google account (classes they linked stop syncing). */
  app.delete<{ Params: { institutionId: string } }>("/v1/institutions/:institutionId/google", async (req) => {
    const actor = await authenticate(req, db, verifier);
    const institutionId = uuid.parse(req.params.institutionId);
    await db
      .deleteFrom("google_accounts")
      .where("institution_id", "=", institutionId)
      .where("profile_id", "=", actor.userId)
      .execute();
    return { disconnected: true };
  });

  const myAccount = (institutionId: string, userId: string) =>
    db
      .selectFrom("google_accounts")
      .select(["id", "revoked_at"])
      .where("institution_id", "=", institutionId)
      .where("profile_id", "=", userId)
      .executeTakeFirst();

  const loadCourse = async (courseId: string) => {
    const course = await db
      .selectFrom("courses")
      .select(["id", "institution_id", "archived_at"])
      .where("id", "=", uuid.parse(courseId))
      .executeTakeFirst();
    if (!course) throw notFound("Course not found");
    return course;
  };

  const classroomError = (err: unknown): never => {
    if (err instanceof GoogleError) {
      throw new HttpError(
        err.code === "auth_revoked" ? 409 : 502,
        err.code === "auth_revoked" ? "google_reconnect" : "google_failed",
        err.message,
      );
    }
    throw err;
  };

  /** The Classroom classes the teacher teaches (to pick one to link). */
  app.get<{ Params: { courseId: string } }>("/v1/courses/:courseId/classroom-classes", async (req) => {
    const actor = await authenticate(req, db, verifier);
    const course = await loadCourse(req.params.courseId);
    authorize(actor, "manageCourse", course.institution_id, await courseRoleOf(db, course.id, actor.userId));
    const account = await myAccount(course.institution_id, actor.userId);
    if (!account || account.revoked_at) throw conflict("google_reconnect", "Connect your Google account first.");
    const classes = await withClassroom(deps, account.id, (c) => c.courses()).catch(classroomError);
    const conn = await classroomConnection(db, course.institution_id);
    const linked = conn
      ? await db
          .selectFrom("lms_course_links")
          .select(["context_id", "course_id"])
          .where("lms_connection_id", "=", conn.id)
          .execute()
      : [];
    return {
      classes: classes.map((c) => ({
        ...c,
        linkedCourseId: linked.find((l) => l.context_id === c.id)?.course_id ?? null,
      })),
    };
  });

  /** Links one of the teacher's Classroom classes to the course; its roster is read at once. */
  app.post<{ Params: { courseId: string } }>("/v1/courses/:courseId/classroom-links", async (req, reply) => {
    const actor = await authenticate(req, db, verifier);
    const course = await loadCourse(req.params.courseId);
    authorize(actor, "manageCourse", course.institution_id, await courseRoleOf(db, course.id, actor.userId));
    if (course.archived_at) throw conflict("course_archived", "That course is archived.");
    const { classId } = z.object({ classId: z.string().min(1).max(100) }).parse(req.body);
    const conn = await classroomConnection(db, course.institution_id);
    if (conn?.status !== "active")
      throw conflict("classroom_off", "Google Classroom isn't turned on for your institution.");
    const account = await myAccount(course.institution_id, actor.userId);
    if (!account || account.revoked_at) throw conflict("google_reconnect", "Connect your Google account first.");
    const theirs = (await withClassroom(deps, account.id, (c) => c.courses()).catch(classroomError)).find(
      (c) => c.id === classId,
    );
    if (!theirs) throw new ForbiddenError("You don't teach that Google Classroom class.");
    const existing = await db
      .selectFrom("lms_course_links")
      .select(["id", "course_id"])
      .where("lms_connection_id", "=", conn.id)
      .where("context_id", "=", classId)
      .executeTakeFirst();
    if (existing?.course_id && existing.course_id !== course.id) {
      throw conflict("already_linked", "That class is already linked to another course.");
    }
    const title = theirs.section ? `${theirs.name} (${theirs.section})` : theirs.name;
    const link = await withActor(db, actor.userId, (tx) =>
      tx
        .insertInto("lms_course_links")
        .values({
          institution_id: course.institution_id,
          lms_connection_id: conn.id,
          context_id: classId,
          context_title: title,
          course_id: course.id,
          google_account_id: account.id,
          linked_by: actor.userId,
        })
        .onConflict((oc) =>
          oc.columns(["lms_connection_id", "context_id"]).doUpdateSet({
            context_title: title,
            course_id: course.id,
            google_account_id: account.id,
            linked_by: actor.userId,
          }),
        )
        .returning("id")
        .executeTakeFirstOrThrow(),
    );
    await queue.send("lms-roster-sync", { courseLinkId: link.id }, { singletonKey: `roster-${link.id}` });
    return reply.code(201).send({ id: link.id });
  });

  /** Posts the assignment to the course's Classroom classes as coursework (grades go there). */
  app.post<{ Params: { assignmentId: string } }>("/v1/assignments/:assignmentId/classroom-coursework", async (req) => {
    const actor = await authenticate(req, db, verifier);
    const a = await db
      .selectFrom("assignments")
      .select(["id", "institution_id", "course_id", "status"])
      .where("id", "=", uuid.parse(req.params.assignmentId))
      .executeTakeFirst();
    if (!a) throw notFound("Assignment not found");
    authorize(actor, "manageCourse", a.institution_id, await courseRoleOf(db, a.course_id, actor.userId));
    if (a.status !== "published") throw conflict("not_published", "Publish the assignment first.");
    return postToClassroom({ db, settings, queue }, a.id, actor.userId);
  });
}
