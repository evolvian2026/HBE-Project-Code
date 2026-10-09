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

/**
 * What a verified launch leads to (§4.2, §13.2): the person is matched to their profile (an
 * earlier launch, else their email among the institution's members or pending invitations,
 * else an admin reviews them), the LMS course is recorded (and linked by an instructor if it
 * isn't yet), learners join the linked course, and they land on the assignment, the course or
 * the institution.
 */
export async function handleLaunch(
  db: Db,
  signIn: SignInService,
  conn: { id: string; institution_id: string },
  launch: Launch,
): Promise<LaunchOutcome> {
  const inst = await db
    .selectFrom("institutions")
    .select(["id", "name", "slug", "status"])
    .where("id", "=", conn.institution_id)
    .executeTakeFirstOrThrow();
  if (inst.status !== "active" && inst.status !== "read_only") {
    return { kind: "refused", message: `${inst.name} isn't available on the platform.` };
  }

  // Who is this?
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
      // Invited but never signed in: create their account; the invitation is accepted on sign-in.
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
  if (!profileId) return { kind: "pending", institution: inst.name };

  // Which course?
  let next = `/i/${inst.slug}`;
  if (launch.context) {
    const link = await db
      .insertInto("lms_course_links")
      .values({
        institution_id: inst.id,
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
    if (link.course_id) {
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
      const assignmentId = launch.custom.assignment_id;
      if (assignmentId && /^[0-9a-f-]{36}$/.test(assignmentId)) {
        const assignment = await db
          .selectFrom("assignments")
          .select("id")
          .where("id", "=", assignmentId)
          .where("course_id", "=", link.course_id)
          .executeTakeFirst();
        if (assignment) next = `${next}/assignments/${assignment.id}`;
      }
    } else if (launch.courseRole === "instructor" || launch.lmsAdmin) {
      next = `/i/${inst.slug}/lti/link-course/${link.id}`;
    } else {
      next = `/i/${inst.slug}?lti=course-not-linked`;
    }
  }

  const profile = await db.selectFrom("profiles").select("email").where("id", "=", profileId).executeTakeFirstOrThrow();
  if (!profile.email)
    return { kind: "refused", message: "Your platform account has no email address to sign in with." };
  return { kind: "signed_in", tokenHash: await signIn.signInToken(profile.email), next };
}
