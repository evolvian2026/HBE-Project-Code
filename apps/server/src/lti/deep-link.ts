import { randomBytes } from "node:crypto";
import type { Db } from "@hbe/db";
import { deepLinkingResponse, toolEndpoints, type Launch } from "@hbe/lms";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiDeps } from "../app.ts";
import { hashToken, platformOf } from "./platform.ts";
import { toolKeys } from "./keys.ts";
import { identify, recordCourse } from "./launch.ts";
import { escapeHtml, page } from "./pages.ts";
import type { SignInService } from "./sign-in.ts";

const REQUEST_TTL_MS = 60 * 60_000;
const MAX_ITEMS = 20;

/**
 * An LtiDeepLinkingRequest (the LMS asks which content to add): instructors (and LMS admins)
 * with a platform account get a single-use picker. The picker runs inside the LMS's frame,
 * where the platform's session cookie isn't available, so its URL token is its credential.
 */
export async function startDeepLink(
  db: Db,
  signIn: SignInService,
  conn: { id: string; institution_id: string },
  launch: Launch,
): Promise<{ token: string } | { refused: string }> {
  if (launch.courseRole !== "instructor" && !launch.lmsAdmin) {
    return { refused: "Only instructors can add HBE Projects assignments to a course." };
  }
  if (!launch.deepLinking?.acceptTypes.includes("ltiResourceLink")) {
    return { refused: "This place in the LMS doesn't accept links to assignments." };
  }
  const who = await identify(db, signIn, conn, launch);
  if (who.kind === "refused") return { refused: who.message };
  if (who.kind === "pending") {
    return {
      refused: `We couldn't match your LMS account to an HBE Projects account. ${who.inst.name}'s admin has been asked to link it; try again after that.`,
    };
  }
  const link = await recordCourse(db, conn, launch);
  const token = randomBytes(32).toString("base64url");
  await db
    .insertInto("lti_deep_link_requests")
    .values({
      token_hash: hashToken(token),
      lms_connection_id: conn.id,
      lms_course_link_id: link?.id ?? null,
      profile_id: who.profileId,
      deployment_id: launch.deploymentId,
      return_url: launch.deepLinking.returnUrl,
      data: launch.deepLinking.data,
      accept_multiple: launch.deepLinking.acceptMultiple,
      expires_at: new Date(Date.now() + REQUEST_TTL_MS),
    })
    .execute();
  return { token };
}

interface Choice {
  course: { id: string; code: string; name: string };
  assignments: { id: string; title: string; due_at: Date | string }[];
}

/** The courses (and their published assignments) the person may add from this LMS course. */
async function choicesFor(
  db: Db,
  request: { profile_id: string; institution_id: string; linked_course_id: string | null },
): Promise<Choice[]> {
  const admin = await db
    .selectFrom("institution_memberships")
    .select("id")
    .where("institution_id", "=", request.institution_id)
    .where("user_id", "=", request.profile_id)
    .where("role", "=", "admin")
    .where("status", "=", "active")
    .executeTakeFirst();
  let courses = db
    .selectFrom("courses as c")
    .select(["c.id", "c.code", "c.name"])
    .where("c.institution_id", "=", request.institution_id)
    .where("c.archived_at", "is", null)
    .orderBy("c.code");
  if (!admin) {
    courses = courses.where(({ exists, selectFrom }) =>
      exists(
        selectFrom("course_memberships as m")
          .select("m.id")
          .whereRef("m.course_id", "=", "c.id")
          .where("m.user_id", "=", request.profile_id)
          .where("m.role", "=", "instructor"),
      ),
    );
  }
  if (request.linked_course_id) courses = courses.where("c.id", "=", request.linked_course_id);
  const list = await courses.execute();
  if (!list.length) return [];
  const assignments = await db
    .selectFrom("assignments")
    .select(["id", "course_id", "title", "due_at"])
    .where(
      "course_id",
      "in",
      list.map((c) => c.id),
    )
    .where("status", "=", "published")
    .orderBy("due_at")
    .execute();
  return list.map((course) => ({ course, assignments: assignments.filter((a) => a.course_id === course.id) }));
}

const due = (d: Date | string) =>
  new Date(d).toLocaleString("en-SG", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Singapore" });

/** The picker (GET) and its answer to the LMS (POST): `/lti/deep-link/:token`. */
export function registerDeepLinking(app: FastifyInstance, deps: ApiDeps): void {
  const { db, settings } = deps;

  const load = (token: string) =>
    db
      .selectFrom("lti_deep_link_requests as r")
      .innerJoin("lms_connections as c", "c.id", "r.lms_connection_id")
      .leftJoin("lms_course_links as l", "l.id", "r.lms_course_link_id")
      .select([
        "r.id",
        "r.profile_id",
        "r.deployment_id",
        "r.return_url",
        "r.data",
        "r.accept_multiple",
        "r.lms_course_link_id",
        "c.institution_id",
        "c.issuer",
        "c.client_id",
        "c.deployment_ids",
        "c.auth_login_url",
        "c.auth_token_url",
        "c.jwks_url",
        "c.status as connection_status",
        "l.context_title",
        "l.course_id as linked_course_id",
      ])
      .where("r.token_hash", "=", hashToken(token))
      .where("r.used_at", "is", null)
      .where("r.expires_at", ">", new Date())
      .executeTakeFirst();

  app.get<{ Params: { token: string } }>("/lti/deep-link/:token", async (req, reply) => {
    const request = await load(req.params.token);
    if (!request || request.connection_status !== "active") {
      return page(reply, 400, "This link has expired", "Start adding the assignment from your LMS again.");
    }
    const choices = await choicesFor(db, request);
    const where = request.context_title ? `“${request.context_title}”` : "your LMS course";
    if (!choices.length) {
      return page(
        reply,
        403,
        "No courses to add from",
        request.linked_course_id
          ? `${where} is linked to a course you don't teach on HBE Projects.`
          : "You aren't an instructor of any course on HBE Projects yet. Ask your institution's admin to add you.",
      );
    }
    const input = request.accept_multiple ? "checkbox" : "radio";
    const fieldsets = choices
      .map(
        ({ course, assignments }) =>
          `<fieldset><legend>${escapeHtml(`${course.code} · ${course.name}`)}</legend>${
            assignments.length
              ? assignments
                  .map(
                    (a) =>
                      `<label><input type="${input}" name="assignment" value="${a.id}"> <span>${escapeHtml(a.title)} <small>due ${escapeHtml(due(a.due_at))}</small></span></label>`,
                  )
                  .join("")
              : "<small>No published assignments yet.</small>"
          }</fieldset>`,
      )
      .join("");
    const note = request.linked_course_id
      ? ""
      : `<p><small>${escapeHtml(where)} isn't linked to a course yet: adding an assignment links it to that assignment's course, and students who open it join that course.</small></p>`;
    return page(
      reply,
      200,
      `Add HBE Projects assignments to ${request.context_title ?? "the LMS"}`,
      "",
      `<form method="post" action="/lti/deep-link/${escapeHtml(req.params.token)}">${fieldsets}${note}<button type="submit">Add to the LMS</button></form>`,
    );
  });

  app.post<{ Params: { token: string } }>("/lti/deep-link/:token", async (req, reply) => {
    const body = z.object({ assignment: z.union([z.string(), z.array(z.string())]).optional() }).parse(req.body ?? {});
    const ids = [body.assignment ?? []].flat();
    const request = await load(req.params.token);
    if (!request || request.connection_status !== "active") {
      return page(reply, 400, "This link has expired", "Start adding the assignment from your LMS again.");
    }
    const choices = await choicesFor(db, request);
    const chosen = choices.flatMap((c) =>
      c.assignments.filter((a) => ids.includes(a.id)).map((a) => ({ ...a, courseId: c.course.id })),
    );
    const back = `<p><a href="/lti/deep-link/${escapeHtml(req.params.token)}">Choose again</a></p>`;
    if (!chosen.length || chosen.length !== new Set(ids).size || chosen.length > MAX_ITEMS) {
      return page(reply, 400, "Choose an assignment", "Choose at least one of the assignments listed.", back);
    }
    if (!request.accept_multiple && chosen.length > 1) {
      return page(reply, 400, "Choose one assignment", "This place in the LMS takes one assignment at a time.", back);
    }
    const courseIds = new Set(chosen.map((a) => a.courseId));
    if (courseIds.size > 1) {
      return page(reply, 400, "Choose from one course", "An LMS course can be linked to one course only.", back);
    }
    const keys = await toolKeys(settings);
    if (!keys) {
      return page(reply, 503, "Not set up yet", "The platform's LTI key isn't configured. Ask the platform team.");
    }
    // Single use: the first answer wins.
    const used = await db
      .updateTable("lti_deep_link_requests")
      .set({ used_at: new Date() })
      .where("id", "=", request.id)
      .where("used_at", "is", null)
      .returning("id")
      .executeTakeFirst();
    if (!used) return page(reply, 400, "This link has expired", "Start adding the assignment from your LMS again.");

    const courseId = [...courseIds][0]!;
    if (request.lms_course_link_id) {
      if (!request.linked_course_id) {
        await db
          .updateTable("lms_course_links")
          .set({ course_id: courseId, linked_by: request.profile_id })
          .where("id", "=", request.lms_course_link_id)
          .where("course_id", "is", null)
          .execute();
      }
      await db
        .insertInto("lms_assignment_links")
        .values(
          chosen.map((a) => ({
            institution_id: request.institution_id,
            assignment_id: a.id,
            lms_course_link_id: request.lms_course_link_id!,
            created_by: request.profile_id,
          })),
        )
        .onConflict((oc) => oc.columns(["lms_course_link_id", "assignment_id"]).doNothing())
        .execute();
    }
    const { launchUrl } = toolEndpoints(settings.env.API_URL);
    const jwt = await deepLinkingResponse(keys.current, platformOf(request), {
      deploymentId: request.deployment_id,
      data: request.data,
      items: chosen.map((a) => ({
        title: a.title,
        text: `Due ${due(a.due_at)}`,
        url: launchUrl,
        custom: { assignment_id: a.id },
        lineItem: { label: a.title, scoreMaximum: 100, resourceId: a.id, tag: "hbe-grade" },
      })),
    });
    return page(
      reply,
      200,
      "Adding to the LMS…",
      "",
      `<form method="post" action="${escapeHtml(request.return_url)}"><input type="hidden" name="JWT" value="${escapeHtml(jwt)}"><noscript><button type="submit">Continue</button></noscript></form><script>document.forms[0].submit()</script>`,
    );
  });
}
