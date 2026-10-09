import { allowed, ForbiddenError } from "@hbe/core";
import { withActor, type Db } from "@hbe/db";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiDeps } from "../app.ts";
import { authenticate } from "../auth.ts";
import { conflict, notFound } from "../errors.ts";
import { notify, submissionLinks } from "../notifications.ts";
import { computeSubmissionProcess } from "../worker/activity.ts";
import { courseRoleOf } from "./lms.ts";

const uuid = z.string().uuid();
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Recomputes the process scores (frozen ones too: attribution was corrected) of every
 * submission using these repositories, and the grades of finalized ones.
 */
async function rescore(
  deps: Pick<ApiDeps, "db" | "queue"> & { log: FastifyBaseLogger },
  repositoryIds: string[],
): Promise<void> {
  if (!repositoryIds.length) return;
  const subs = await deps.db
    .selectFrom("submissions")
    .select(["id", "finalized_at"])
    .where("repository_id", "in", repositoryIds)
    .execute();
  for (const s of subs) {
    await computeSubmissionProcess(deps, s.id, { refreeze: true });
    if (s.finalized_at)
      await deps.queue.send("compute-grade", { submissionId: s.id }, { singletonKey: `grade-${s.id}` });
  }
}

/** The staff of the course(s) whose assignments use a repository. */
async function repositoryStaff(db: Db, repositoryId: string) {
  return db
    .selectFrom("submissions as s")
    .innerJoin("assignments as a", "a.id", "s.assignment_id")
    .innerJoin("course_memberships as cm", "cm.course_id", "a.course_id")
    .select(["cm.user_id", "cm.role", "a.course_id", "a.institution_id"])
    .distinct()
    .where("s.repository_id", "=", repositoryId)
    .where("cm.role", "in", ["instructor", "ta"])
    .execute();
}

/**
 * Commit claims (§5.4): a student claims commits from their repository that aren't linked to
 * anyone (the git email isn't on their GitHub account); course staff confirm or decline, and
 * may remember the email so later commits from it are credited at once.
 */
export async function claimRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const { db, verifier, queue } = deps;

  app.post<{ Params: { submissionId: string } }>("/v1/submissions/:submissionId/claims", async (req, reply) => {
    const actor = await authenticate(req, db, verifier);
    const s = await db
      .selectFrom("submissions")
      .select(["id", "institution_id", "user_id", "repository_id"])
      .where("id", "=", uuid.parse(req.params.submissionId))
      .executeTakeFirst();
    if (!s) throw notFound("Submission not found");
    if (s.user_id !== actor.userId || actor.memberships.get(s.institution_id)?.institutionStatus !== "active") {
      throw new ForbiddenError("You can only claim commits in your own repository.");
    }
    if (!s.repository_id) throw conflict("no_repository", "Your repository isn't ready yet.");
    const body = z
      .object({
        commitIds: z.array(uuid).min(1, "Choose the commits that are yours.").max(200),
        note: z.string().trim().max(500).optional(),
      })
      .parse(req.body);
    const commits = await db
      .selectFrom("commits")
      .select(["id", "author_profile_id", "is_bot", "details_status"])
      .where("repository_id", "=", s.repository_id)
      .where("id", "in", body.commitIds)
      .execute();
    if (commits.length !== new Set(body.commitIds).size)
      throw notFound("Some of those commits aren't in your repository.");
    if (commits.some((c) => c.author_profile_id !== null || c.is_bot)) {
      throw conflict("already_credited", "Only commits that aren't credited to anyone can be claimed.");
    }
    // GitHub may still match these to an account.
    if (commits.some((c) => c.details_status === "pending")) {
      throw conflict("still_analysing", "Some of those commits are still being analysed. Try again in a minute.");
    }
    const claimed = await withActor(db, actor.userId, async (tx) => {
      let n = 0;
      for (const c of commits) {
        const row = await tx
          .insertInto("commit_claims")
          .values({
            institution_id: s.institution_id,
            commit_id: c.id,
            repository_id: s.repository_id!,
            claimed_by: actor.userId,
            note: body.note || null,
          })
          // Declined before? Asking again (perhaps with a better note) reopens it.
          .onConflict((oc) =>
            oc
              .columns(["commit_id", "claimed_by"])
              .doUpdateSet({ status: "pending", note: body.note || null, reviewed_by: null, reviewed_at: null })
              .where("commit_claims.status", "=", "rejected"),
          )
          .returning("id")
          .executeTakeFirst();
        if (row) n++;
      }
      return n;
    });
    if (claimed) {
      const links = await submissionLinks(db, s.id);
      const who = await db
        .selectFrom("profiles")
        .select(["full_name", "email"])
        .where("id", "=", actor.userId)
        .executeTakeFirst();
      for (const staff of await repositoryStaff(db, s.repository_id)) {
        await notify(
          db,
          {
            institutionId: s.institution_id,
            userId: staff.user_id,
            type: "commit_claim",
            title: `${who?.full_name ?? who?.email ?? "A student"} claimed ${plural(claimed, "commit")}${links ? ` in ${links.title}` : ""}`,
            body: body.note ?? null,
            link: links?.submission ?? null,
            dedupeKey: `claims:${s.id}:${Date.now()}`,
          },
          queue,
        );
      }
    }
    return reply.code(201).send({ claimed });
  });

  /** Course staff approve or decline claims (several at once from the submission page). */
  app.post("/v1/commit-claims/review", async (req) => {
    const actor = await authenticate(req, db, verifier);
    const body = z
      .object({
        claimIds: z.array(uuid).min(1).max(200),
        decision: z.enum(["approve", "reject"]),
        /** Credit later commits from the same git email to the student. */
        rememberEmail: z.boolean().default(false),
      })
      .parse(req.body);
    const claims = await db
      .selectFrom("commit_claims as k")
      .innerJoin("commits as c", "c.id", "k.commit_id")
      .select([
        "k.id",
        "k.institution_id",
        "k.commit_id",
        "k.repository_id",
        "k.claimed_by",
        "k.status",
        "c.author_profile_id",
        "c.author_email",
      ])
      .where("k.id", "in", body.claimIds)
      .execute();
    if (claims.length !== new Set(body.claimIds).size) throw notFound("Claim not found");
    // Staff of a course using each claim's repository (instructors and TAs).
    for (const repositoryId of new Set(claims.map((k) => k.repository_id))) {
      const staff = await repositoryStaff(db, repositoryId);
      const mine = staff.find((m) => m.user_id === actor.userId);
      const inst = claims.find((k) => k.repository_id === repositoryId)!.institution_id;
      const courseId = staff[0]?.course_id ?? null;
      const role = mine?.role ?? (courseId ? await courseRoleOf(db, courseId, actor.userId) : null);
      if (!allowed(actor, "actAsCourseStaff", inst, role)) throw new ForbiddenError();
    }
    if (claims.some((k) => k.status !== "pending"))
      throw conflict("already_reviewed", "Some of those claims were already decided.");

    const touched = new Set<string>();
    await withActor(db, actor.userId, async (tx) => {
      for (const k of claims) {
        if (body.decision === "reject") {
          await tx
            .updateTable("commit_claims")
            .set({ status: "rejected", reviewed_by: actor.userId, reviewed_at: new Date() })
            .where("id", "=", k.id)
            .execute();
          continue;
        }
        if (k.author_profile_id)
          throw conflict("already_credited", "A commit was credited to someone in the meantime.");
        await tx
          .updateTable("commit_claims")
          .set({ status: "approved", reviewed_by: actor.userId, reviewed_at: new Date() })
          .where("id", "=", k.id)
          .execute();
        // Anyone else's claim to the same commit is declined.
        await tx
          .updateTable("commit_claims")
          .set({ status: "rejected", reviewed_by: actor.userId, reviewed_at: new Date() })
          .where("commit_id", "=", k.commit_id)
          .where("id", "!=", k.id)
          .where("status", "=", "pending")
          .execute();
        await tx
          .updateTable("commits")
          .set({ author_profile_id: k.claimed_by, attribution: "claim" })
          .where("id", "=", k.commit_id)
          .execute();
        touched.add(k.repository_id);
        if (body.rememberEmail && k.author_email) {
          await tx
            .insertInto("commit_author_aliases")
            .values({
              institution_id: k.institution_id,
              email: k.author_email,
              profile_id: k.claimed_by,
              confirmed_by: actor.userId,
            })
            .onConflict((oc) => oc.columns(["institution_id", "email"]).doNothing())
            .execute();
          // Their other unclaimed commits from that email, in any repository of the institution.
          const credited = await tx
            .updateTable("commits")
            .set({ author_profile_id: k.claimed_by, attribution: "alias" })
            .where("institution_id", "=", k.institution_id)
            .where("author_email", "=", k.author_email)
            .where("author_profile_id", "is", null)
            .where("is_bot", "=", false)
            .returning("repository_id")
            .execute();
          for (const c of credited) touched.add(c.repository_id);
        }
      }
    });
    await rescore({ db, queue, log: req.log }, [...touched]);

    // Tell each student once.
    const byStudent = new Map<string, typeof claims>();
    for (const k of claims) byStudent.set(k.claimed_by, [...(byStudent.get(k.claimed_by) ?? []), k]);
    for (const [studentId, theirs] of byStudent) {
      const sub = await db
        .selectFrom("submissions")
        .select("id")
        .where("user_id", "=", studentId)
        .where("repository_id", "=", theirs[0]!.repository_id)
        .executeTakeFirst();
      const links = sub ? await submissionLinks(db, sub.id) : null;
      await notify(
        db,
        {
          institutionId: theirs[0]!.institution_id,
          userId: studentId,
          type: "commit_claim",
          title:
            body.decision === "approve"
              ? `Your claim to ${plural(theirs.length, "commit")} was confirmed: they count for you now`
              : `Your claim to ${plural(theirs.length, "commit")} was declined`,
          link: links?.assignment ?? null,
          dedupeKey: `claim-review:${theirs.map((k) => k.id).sort()[0]}:${body.decision}`,
        },
        queue,
      );
    }
    return { decided: claims.length, rescored: touched.size };
  });
}
