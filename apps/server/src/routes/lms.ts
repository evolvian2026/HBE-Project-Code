import { randomBytes } from "node:crypto";
import { authorize } from "@hbe/core";
import { withActor, type Db } from "@hbe/db";
import { toolEndpoints } from "@hbe/lms";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiDeps } from "../app.ts";
import { authenticate } from "../auth.ts";
import { conflict, notFound } from "../errors.ts";
import { queueAssignmentSync, queueCourseSync } from "../lti/grades.ts";
import { hashToken } from "../lti/platform.ts";

const INVITE_TTL_DAYS = 7;
const uuid = z.string().uuid();
const LTI_TYPES = ["canvas", "moodle", "lti"] as const;

async function courseRoleOf(db: Db, courseId: string, userId: string): Promise<string | null> {
  const row = await db
    .selectFrom("course_memberships")
    .select("role")
    .where("course_id", "=", courseId)
    .where("user_id", "=", userId)
    .executeTakeFirst();
  return row?.role ?? null;
}

const isUniqueViolation = (err: unknown) => (err as { code?: string }).code === "23505";

/**
 * Managing LMS connections (§13): institution admins register their LMS (by hand or with a
 * one-time Dynamic Registration link), review LMS users who couldn't be matched, and instructors
 * link LMS courses to platform courses.
 */
export async function lmsRoutes(app: FastifyInstance, { db, verifier, settings, queue }: ApiDeps): Promise<void> {
  const local = settings.env.HBE_ENV === "local";
  const platformUrl = z
    .string()
    .trim()
    .url()
    .refine((u) => local || u.startsWith("https://"), "LMS addresses must use HTTPS.");

  /** A manual LTI 1.3 registration: the admin copies the platform's details from their LMS. */
  app.post<{ Params: { institutionId: string } }>(
    "/v1/institutions/:institutionId/lms-connections",
    async (req, reply) => {
      const actor = await authenticate(req, db, verifier);
      const institutionId = uuid.parse(req.params.institutionId);
      authorize(actor, "manageInstitution", institutionId);
      const body = z
        .object({
          type: z.enum(LTI_TYPES),
          name: z.string().trim().min(1, "Give the connection a name.").max(120),
          issuer: platformUrl,
          clientId: z.string().trim().min(1, "Enter the client ID.").max(255),
          deploymentIds: z.array(z.string().trim().min(1).max(255)).max(50).default([]),
          authLoginUrl: platformUrl,
          authTokenUrl: platformUrl,
          jwksUrl: platformUrl,
        })
        .parse(req.body);
      try {
        const conn = await withActor(db, actor.userId, (tx) =>
          tx
            .insertInto("lms_connections")
            .values({
              institution_id: institutionId,
              type: body.type,
              name: body.name,
              issuer: body.issuer.replace(/\/$/, ""),
              client_id: body.clientId,
              deployment_ids: body.deploymentIds,
              auth_login_url: body.authLoginUrl,
              auth_token_url: body.authTokenUrl,
              jwks_url: body.jwksUrl,
              registered_by: "manual",
              created_by: actor.userId,
            })
            .returning(["id"])
            .executeTakeFirstOrThrow(),
        );
        return reply.code(201).send(conn);
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw conflict("already_registered", "This LMS client ID is already connected to the platform.");
        }
        throw err;
      }
    },
  );

  /** Renames, turns off or on, or updates the deployments and addresses of a connection. */
  app.patch<{ Params: { connectionId: string } }>("/v1/lms-connections/:connectionId", async (req) => {
    const actor = await authenticate(req, db, verifier);
    const conn = await db
      .selectFrom("lms_connections")
      .select(["id", "institution_id"])
      .where("id", "=", uuid.parse(req.params.connectionId))
      .executeTakeFirst();
    if (!conn) throw notFound("Connection not found");
    authorize(actor, "manageInstitution", conn.institution_id);
    const body = z
      .object({
        name: z.string().trim().min(1).max(120).optional(),
        status: z.enum(["active", "disabled"]).optional(),
        deploymentIds: z.array(z.string().trim().min(1).max(255)).max(50).optional(),
        authLoginUrl: platformUrl.optional(),
        authTokenUrl: platformUrl.optional(),
        jwksUrl: platformUrl.optional(),
      })
      .parse(req.body);
    await withActor(db, actor.userId, (tx) =>
      tx
        .updateTable("lms_connections")
        .set({
          ...(body.name !== undefined && { name: body.name }),
          ...(body.status !== undefined && { status: body.status }),
          ...(body.deploymentIds !== undefined && { deployment_ids: body.deploymentIds }),
          ...(body.authLoginUrl !== undefined && { auth_login_url: body.authLoginUrl }),
          ...(body.authTokenUrl !== undefined && { auth_token_url: body.authTokenUrl }),
          ...(body.jwksUrl !== undefined && { jwks_url: body.jwksUrl }),
        })
        .where("id", "=", conn.id)
        .execute(),
    );
    return { id: conn.id };
  });

  /**
   * A one-time Dynamic Registration URL for the admin to paste into their LMS (Canvas: Developer
   * Keys → LTI Registration; Moodle: Manage tools → Tool URL). Only its hash is stored.
   */
  app.post<{ Params: { institutionId: string } }>(
    "/v1/institutions/:institutionId/lti-registrations",
    async (req, reply) => {
      const actor = await authenticate(req, db, verifier);
      const institutionId = uuid.parse(req.params.institutionId);
      authorize(actor, "manageInstitution", institutionId);
      const body = z
        .object({
          type: z.enum(LTI_TYPES),
          name: z.string().trim().min(1, "Give the connection a name.").max(120),
        })
        .parse(req.body);
      const token = randomBytes(32).toString("base64url");
      const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000);
      const invite = await withActor(db, actor.userId, (tx) =>
        tx
          .insertInto("lti_registration_invites")
          .values({
            institution_id: institutionId,
            token_hash: hashToken(token),
            type: body.type,
            name: body.name,
            created_by: actor.userId,
            expires_at: expiresAt,
          })
          .returning(["id", "expires_at"])
          .executeTakeFirstOrThrow(),
      );
      const url = new URL(toolEndpoints(settings.env.API_URL).registrationUrl);
      url.searchParams.set("invite", token);
      return reply.code(201).send({ ...invite, url: url.toString() });
    },
  );

  /**
   * An admin decides about an LMS user who couldn't be matched by email: link them to a member
   * of the institution, or refuse their launches.
   */
  app.post<{ Params: { linkId: string } }>("/v1/lms-user-links/:linkId/resolve", async (req) => {
    const actor = await authenticate(req, db, verifier);
    const link = await db
      .selectFrom("lms_user_links")
      .select(["id", "institution_id", "lms_connection_id", "status"])
      .where("id", "=", uuid.parse(req.params.linkId))
      .executeTakeFirst();
    if (!link) throw notFound("LMS user not found");
    authorize(actor, "manageInstitution", link.institution_id);
    const body = z
      .discriminatedUnion("action", [
        z.object({ action: z.literal("link"), profileId: uuid }),
        z.object({ action: z.literal("reject") }),
        z.object({ action: z.literal("reset") }),
      ])
      .parse(req.body);

    if (body.action === "link") {
      const member = await db
        .selectFrom("institution_memberships")
        .select("user_id")
        .where("institution_id", "=", link.institution_id)
        .where("user_id", "=", body.profileId)
        .where("status", "=", "active")
        .executeTakeFirst();
      if (!member) throw conflict("not_a_member", "Choose an active member of the institution.");
      const taken = await db
        .selectFrom("lms_user_links")
        .select("id")
        .where("lms_connection_id", "=", link.lms_connection_id)
        .where("profile_id", "=", body.profileId)
        .where("id", "<>", link.id)
        .executeTakeFirst();
      if (taken) throw conflict("already_linked", "That member is already linked to another account in this LMS.");
    }
    const values =
      body.action === "link"
        ? { status: "linked" as const, profile_id: body.profileId, matched_by: "admin" as const }
        : { status: body.action === "reject" ? ("rejected" as const) : ("pending" as const), profile_id: null };
    await withActor(db, actor.userId, (tx) =>
      tx.updateTable("lms_user_links").set(values).where("id", "=", link.id).execute(),
    );
    return { id: link.id, status: values.status };
  });

  /**
   * Links an LMS course to a platform course: its instructors (or the institution's admins).
   * Learners launching from it then join the course.
   */
  app.post<{ Params: { linkId: string } }>("/v1/lms-course-links/:linkId/link", async (req) => {
    const actor = await authenticate(req, db, verifier);
    const link = await db
      .selectFrom("lms_course_links")
      .select(["id", "institution_id", "course_id"])
      .where("id", "=", uuid.parse(req.params.linkId))
      .executeTakeFirst();
    if (!link) throw notFound("LMS course not found");
    const { courseId } = z.object({ courseId: uuid }).parse(req.body);
    const course = await db
      .selectFrom("courses")
      .select(["id", "institution_id", "archived_at"])
      .where("id", "=", courseId)
      .executeTakeFirst();
    if (!course || course.institution_id !== link.institution_id) throw notFound("Course not found");
    authorize(actor, "manageCourse", link.institution_id, await courseRoleOf(db, course.id, actor.userId));
    if (link.course_id && link.course_id !== course.id) {
      // Moving a link away from a course is for that course's instructors too.
      authorize(actor, "manageCourse", link.institution_id, await courseRoleOf(db, link.course_id, actor.userId));
    }
    if (course.archived_at) throw conflict("course_archived", "That course is archived.");
    await withActor(db, actor.userId, (tx) =>
      tx
        .updateTable("lms_course_links")
        .set({ course_id: course.id, linked_by: actor.userId })
        .where("id", "=", link.id)
        .execute(),
    );
    // Grades released before the link go to the LMS gradebook now.
    await queueCourseSync(db, queue, course.id);
    return { id: link.id, courseId: course.id };
  });

  app.post<{ Params: { linkId: string } }>("/v1/lms-course-links/:linkId/unlink", async (req) => {
    const actor = await authenticate(req, db, verifier);
    const link = await db
      .selectFrom("lms_course_links")
      .select(["id", "institution_id", "course_id"])
      .where("id", "=", uuid.parse(req.params.linkId))
      .executeTakeFirst();
    if (!link) throw notFound("LMS course not found");
    if (!link.course_id) return { id: link.id, courseId: null };
    authorize(actor, "manageCourse", link.institution_id, await courseRoleOf(db, link.course_id, actor.userId));
    await withActor(db, actor.userId, (tx) =>
      tx
        .updateTable("lms_course_links")
        .set({ course_id: null, linked_by: actor.userId })
        .where("id", "=", link.id)
        .execute(),
    );
    return { id: link.id, courseId: null };
  });

  /** Sends an assignment's released grades to the LMS gradebooks again (all, or some students). */
  app.post<{ Params: { assignmentId: string } }>("/v1/assignments/:assignmentId/lms-sync", async (req, reply) => {
    const actor = await authenticate(req, db, verifier);
    const a = await db
      .selectFrom("assignments")
      .select(["id", "institution_id", "course_id"])
      .where("id", "=", uuid.parse(req.params.assignmentId))
      .executeTakeFirst();
    if (!a) throw notFound("Assignment not found");
    authorize(actor, "manageCourse", a.institution_id, await courseRoleOf(db, a.course_id, actor.userId));
    const { submissionIds } = z.object({ submissionIds: z.array(uuid).max(1000).optional() }).parse(req.body ?? {});
    const queued = await queueAssignmentSync(db, queue, a.id, { submissionIds, force: true });
    return reply.code(202).send({ queued });
  });

  /** Reads the LMS course's roster now (it is also read every night). */
  app.post<{ Params: { linkId: string } }>("/v1/lms-course-links/:linkId/roster-sync", async (req, reply) => {
    const actor = await authenticate(req, db, verifier);
    const link = await db
      .selectFrom("lms_course_links")
      .select(["id", "institution_id", "course_id", "nrps_url"])
      .where("id", "=", uuid.parse(req.params.linkId))
      .executeTakeFirst();
    if (!link?.course_id) throw notFound("Linked LMS course not found");
    authorize(actor, "manageCourse", link.institution_id, await courseRoleOf(db, link.course_id, actor.userId));
    if (!link.nrps_url) {
      throw conflict("no_roster_service", "This LMS course doesn't share its roster (NRPS) with the platform.");
    }
    await queue.send("lms-roster-sync", { courseLinkId: link.id }, { singletonKey: `roster-${link.id}` });
    return reply.code(202).send({ queued: true });
  });
}
