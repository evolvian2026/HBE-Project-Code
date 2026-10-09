import { ForbiddenError, roleIn, type Actor } from "@hbe/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiDeps } from "../app.ts";
import type { ArchiveStore } from "../archive.ts";
import { authenticate } from "../auth.ts";
import { conflict, notFound } from "../errors.ts";
import { EXPORT_BUCKET } from "../records/deps.ts";
import { endContract, reopenContract } from "../records/lifecycle.ts";
import type { ObjectStore } from "../storage.ts";

/**
 * Institution admins (MFA satisfied), also once the contract has ended, and super admins:
 * exports must stay possible while the institution is read-only.
 */
function isRecordsAdmin(actor: Actor, institutionId: string): boolean {
  if (actor.isSuperAdmin) return true;
  const status = actor.memberships.get(institutionId)?.institutionStatus;
  return roleIn(actor, institutionId) === "admin" && (status === "active" || status === "read_only");
}

/** The records lifecycle (§12.5): ending a contract, and full exports. */
export async function recordsRoutes(
  app: FastifyInstance,
  deps: ApiDeps & { store: ObjectStore; archive: ArchiveStore | null },
): Promise<void> {
  const { db, verifier, queue, store, archive, settings } = deps;
  const loadInstitution = async (id: string) => {
    const inst = await db
      .selectFrom("institutions")
      .select(["id", "status", "contract_ended_at", "purge_after"])
      .where("id", "=", z.string().uuid().parse(id))
      .executeTakeFirst();
    if (!inst) throw notFound("Institution not found");
    return inst;
  };

  /**
   * Ends the contract (the institution becomes read-only; its records are purged two years
   * later) or, for super admins, reopens it.
   */
  app.post<{ Params: { institutionId: string } }>("/v1/institutions/:institutionId/contract", async (req) => {
    const actor = await authenticate(req, db, verifier);
    const inst = await loadInstitution(req.params.institutionId);
    const body = z
      .discriminatedUnion("action", [
        z.object({ action: z.literal("end"), endedAt: z.coerce.date().optional() }),
        z.object({ action: z.literal("reopen") }),
      ])
      .parse(req.body);
    if (body.action === "reopen") {
      if (!actor.isSuperAdmin) throw new ForbiddenError("Only platform admins can reopen a contract.");
      const updated = await reopenContract(db, inst.id, actor.userId);
      if (!updated) throw conflict("not_ended", "This institution's contract hasn't ended.");
      return { institution: updated };
    }
    const status = actor.memberships.get(inst.id)?.institutionStatus;
    if (!actor.isSuperAdmin && !(roleIn(actor, inst.id) === "admin" && status === "active")) throw new ForbiddenError();
    if (inst.status !== "active") throw conflict("not_active", "This institution's contract has already ended.");
    const endedAt = body.endedAt ?? new Date();
    if (endedAt.getTime() > Date.now() + 60_000) throw conflict("future", "The end date can't be in the future.");
    const updated = await endContract(db, inst.id, {
      endedAt,
      actorId: actor.userId,
      graceYears: settings.profile.retention.contract_grace_years,
    });
    return { institution: updated };
  });

  /** Starts a full export of the institution's records (built by the worker). */
  app.post<{ Params: { institutionId: string } }>("/v1/institutions/:institutionId/exports", async (req, reply) => {
    const actor = await authenticate(req, db, verifier);
    const inst = await loadInstitution(req.params.institutionId);
    if (!isRecordsAdmin(actor, inst.id)) throw new ForbiddenError();
    if (inst.status === "purged") throw conflict("purged", "This institution's records have been deleted.");
    const running = await db
      .selectFrom("record_exports")
      .select("id")
      .where("institution_id", "=", inst.id)
      .where("status", "in", ["queued", "running"])
      .executeTakeFirst();
    if (running) throw conflict("export_running", "An export is already being prepared.");
    const created = await db
      .insertInto("record_exports")
      .values({ institution_id: inst.id, requested_by: actor.userId })
      .returning(["id", "status", "created_at"])
      .executeTakeFirstOrThrow();
    await queue.send("records-export", { exportId: created.id }, { singletonKey: `export-${created.id}` });
    return reply.code(201).send({ export: created });
  });

  /** A short-lived download URL for a finished export. */
  app.get<{ Params: { exportId: string } }>("/v1/record-exports/:exportId/download", async (req) => {
    const actor = await authenticate(req, db, verifier);
    const exp = await db
      .selectFrom("record_exports")
      .select(["id", "institution_id", "status", "location", "path", "created_at"])
      .where("id", "=", z.string().uuid().parse(req.params.exportId))
      .executeTakeFirst();
    if (!exp) throw notFound("Export not found");
    if (!isRecordsAdmin(actor, exp.institution_id)) throw new ForbiddenError();
    if (exp.status !== "ready" || !exp.path) throw conflict("not_ready", "This export isn't ready.");
    const filename = `records-${exp.created_at.toISOString().slice(0, 10)}.zip`;
    if (exp.location === "archive") {
      if (!archive) throw conflict("no_archive", "The archive bucket isn't configured.");
      return { url: await archive.downloadUrl(exp.path, 300, filename) };
    }
    return { url: await store.signedDownloadUrl(EXPORT_BUCKET, exp.path, 300, filename) };
  });
}
