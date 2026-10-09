import { sql, type Db } from "@hbe/db";
import type { Launch } from "@hbe/lms";
import type { SignInService } from "./sign-in.ts";

/**
 * Accepts the person's pending invitations now (as accept_my_invitations does at sign-in), so
 * they are a member, and can join the LMS course, before their browser signs in.
 */
async function acceptInvitations(db: Db, userId: string): Promise<void> {
  await db.transaction().execute(async (tx) => {
    const claims = JSON.stringify({ sub: userId, role: "authenticated" });
    await sql`select set_config('request.jwt.claims', ${claims}, true)`.execute(tx);
    await sql`select public.accept_my_invitations()`.execute(tx);
  });
}

export type LaunchOutcome =
  | { kind: "signed_in"; tokenHash: string; next: string }
  | { kind: "pending"; institution: string }
  | { kind: "refused"; message: string };

export interface Institution {
  id: string;
  name: string;
  slug: string;
  status: string;
}

export type Identity =
  | { kind: "linked"; profileId: string; inst: Institution }
  | { kind: "pending"; inst: Institution }
  | { kind: "refused"; message: string };

/**
 * Who launched (§4.2, §13.2): an earlier match, else their email among the institution's
 * members, else a pending invitation (the account is created and the invitation accepted),
 * else an admin reviews them. The LMS user is recorded either way.
 */
export async function identify(
  db: Db,
  signIn: SignInService,
  conn: { id: string; institution_id: string },
  launch: Launch,
): Promise<Identity> {
  const inst = await db
    .selectFrom("institutions")
    .select(["id", "name", "slug", "status"])
    .where("id", "=", conn.institution_id)
    .executeTakeFirstOrThrow();
  if (inst.status !== "active" && inst.status !== "read_only") {
    return { kind: "refused", message: `${inst.name} isn't available on the platform.` };
  }

  const existing = await db
    .selectFrom("lms_user_links")
    .select(["id", "profile_id", "status"])
    .where("lms_connection_id", "=", conn.id)
    .where("lms_user_id", "=", launch.userId)
    .executeTakeFirst();
  if (existing?.status === "rejected") {
    return {
      kind: "refused",
      message: "Your LMS account can't be used to sign in here. Ask your institution's admin.",
    };
  }
  let profileId = existing?.status === "linked" ? existing.profile_id : null;
  if (!profileId && launch.email) {
    profileId =
      (
        await db
          .selectFrom("profiles as p")
          .innerJoin("institution_memberships as m", "m.user_id", "p.id")
          .select("p.id")
          .where("m.institution_id", "=", inst.id)
          .where("m.status", "=", "active")
          .where((eb) => eb(eb.fn("lower", ["p.email"]), "=", launch.email))
          .executeTakeFirst()
      )?.id ?? null;
    if (!profileId) {
      const invited = await db
        .selectFrom("invitations")
        .select("id")
        .where("institution_id", "=", inst.id)
        .where("accepted_at", "is", null)
        .where("expires_at", ">", new Date())
        .where((eb) => eb(eb.fn("lower", ["email"]), "=", launch.email))
        .executeTakeFirst();
      if (invited) {
        profileId =
          (
            await db
              .selectFrom("profiles")
              .select("id")
              .where((eb) => eb(eb.fn("lower", ["email"]), "=", launch.email))
              .executeTakeFirst()
          )?.id ?? (await signIn.createUser(launch.email, launch.name));
        await acceptInvitations(db, profileId);
      }
    }
  }
  const now = new Date();
  await db
    .insertInto("lms_user_links")
    .values({
      institution_id: inst.id,
      lms_connection_id: conn.id,
      lms_user_id: launch.userId,
      email: launch.email,
      name: launch.name,
      last_launch_at: now,
      ...(profileId
        ? { profile_id: profileId, status: "linked" as const, matched_by: "email" as const }
        : { profile_id: null, status: "pending" as const, matched_by: null }),
    })
    .onConflict((oc) =>
      oc.columns(["lms_connection_id", "lms_user_id"]).doUpdateSet({
        email: launch.email,
        name: launch.name,
        last_launch_at: now,
        ...(profileId && existing?.status !== "linked"
          ? { profile_id: profileId, status: "linked" as const, matched_by: "email" as const }
          : {}),
      }),
    )
    .execute();
  return profileId ? { kind: "linked", profileId, inst } : { kind: "pending", inst };
}

/** Records the LMS course (LTI context) of a launch with its service endpoints. */
export async function recordCourse(
  db: Db,
  conn: { id: string; institution_id: string },
  launch: Launch,
): Promise<{ id: string; course_id: string | null } | null> {
  if (!launch.context) return null;
  return db
    .insertInto("lms_course_links")
    .values({
      institution_id: conn.institution_id,
      lms_connection_id: conn.id,
      context_id: launch.context.id,
      context_title: launch.context.title ?? launch.context.label,
      nrps_url: launch.nrps?.membershipsUrl ?? null,
      ags_lineitems_url: launch.ags?.lineItemsUrl ?? null,
    })
    .onConflict((oc) =>
      oc.columns(["lms_connection_id", "context_id"]).doUpdateSet((eb) => ({
        context_title: eb.ref("excluded.context_title"),
        nrps_url: eb.fn.coalesce("excluded.nrps_url", "lms_course_links.nrps_url"),
        ags_lineitems_url: eb.fn.coalesce("excluded.ags_lineitems_url", "lms_course_links.ags_lineitems_url"),
      })),
    )
    .returning(["id", "course_id"])
    .executeTakeFirstOrThrow();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Which platform assignment a resource link opens: its `assignment_id` custom parameter (set by
 * deep linking), else an assignment linked to that resource link earlier. The link's gradebook
 * column (AGS `lineitem`) is recorded for grade passback.
 */
async function assignmentOf(
  db: Db,
  link: { id: string; institution_id: string; course_id: string },
  launch: Launch,
): Promise<string | null> {
  const custom = launch.custom.assignment_id;
  let assignmentId: string | null = null;
  if (custom && UUID.test(custom)) {
    assignmentId =
      (
        await db
          .selectFrom("assignments")
          .select("id")
          .where("id", "=", custom)
          .where("course_id", "=", link.course_id)
          .executeTakeFirst()
      )?.id ?? null;
  }
  if (!assignmentId && launch.resourceLink) {
    assignmentId =
      (
        await db
          .selectFrom("lms_assignment_links")
          .select("assignment_id")
          .where("lms_course_link_id", "=", link.id)
          .where("resource_link_id", "=", launch.resourceLink.id)
          .executeTakeFirst()
      )?.assignment_id ?? null;
  }
  if (assignmentId && (launch.ags?.lineItemUrl || launch.resourceLink)) {
    const values = {
      ...(launch.ags?.lineItemUrl ? { lineitem_url: launch.ags.lineItemUrl } : {}),
      ...(launch.resourceLink ? { resource_link_id: launch.resourceLink.id } : {}),
    };
    await db
      .insertInto("lms_assignment_links")
      .values({
        institution_id: link.institution_id,
        assignment_id: assignmentId,
        lms_course_link_id: link.id,
        ...values,
      })
      .onConflict((oc) => oc.columns(["lms_course_link_id", "assignment_id"]).doUpdateSet(values))
      .execute();
  }
  return assignmentId;
}

/**
 * What a verified resource link launch leads to: the person is identified, the LMS course is
 * recorded (and linked by an instructor if it isn't yet), learners join the linked course, and
 * they land on the assignment, the course or the institution.
 */
export async function handleLaunch(
  db: Db,
  signIn: SignInService,
  conn: { id: string; institution_id: string },
  launch: Launch,
): Promise<LaunchOutcome> {
  const who = await identify(db, signIn, conn, launch);
  if (who.kind === "refused") return who;
  if (who.kind === "pending") return { kind: "pending", institution: who.inst.name };
  const { inst, profileId } = who;

  let next = `/i/${inst.slug}`;
  const link = await recordCourse(db, conn, launch);
  if (link?.course_id) {
    next = `/i/${inst.slug}/courses/${link.course_id}`;
    // Learners in the LMS course are students of the linked course.
    if (launch.courseRole === "student") {
      const member = await db
        .selectFrom("institution_memberships")
        .select("id")
        .where("institution_id", "=", inst.id)
        .where("user_id", "=", profileId)
        .where("status", "=", "active")
        .executeTakeFirst();
      if (member) {
        await db
          .insertInto("course_memberships")
          .values({
            institution_id: inst.id,
            course_id: link.course_id,
            user_id: profileId,
            role: "student",
            source: "lms",
          })
          .onConflict((oc) => oc.doNothing())
          .execute();
      }
    }
    const assignmentId = await assignmentOf(
      db,
      { id: link.id, institution_id: inst.id, course_id: link.course_id },
      launch,
    );
    if (assignmentId) next = `${next}/assignments/${assignmentId}`;
  } else if (link && (launch.courseRole === "instructor" || launch.lmsAdmin)) {
    next = `/i/${inst.slug}/lti/link-course/${link.id}`;
  } else if (link) {
    next = `/i/${inst.slug}?lti=course-not-linked`;
  }

  const profile = await db.selectFrom("profiles").select("email").where("id", "=", profileId).executeTakeFirstOrThrow();
  if (!profile.email)
    return { kind: "refused", message: "Your platform account has no email address to sign in with." };
  return { kind: "signed_in", tokenHash: await signIn.signInToken(profile.email), next };
}
