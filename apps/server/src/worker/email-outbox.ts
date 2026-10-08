import { sql, type Db } from "@hbe/db";
import type { FastifyBaseLogger } from "fastify";
import type { EmailSender } from "../email/sender.ts";
import { invitationEmail, type InvitationPayload } from "../email/templates.ts";

const BATCH = 20;
const MAX_ATTEMPTS = 5;

export interface OutboxDeps {
  db: Db;
  sender: EmailSender;
  appUrl: string;
  log: FastifyBaseLogger;
}

/**
 * Claims a batch of pending emails (by bumping attempts under SKIP LOCKED, so parallel
 * workers never take the same row) and sends them. A crash after sending but before
 * marking can resend once: acceptable for notification emails.
 */
export async function drainEmailOutbox({
  db,
  sender,
  appUrl,
  log,
}: OutboxDeps): Promise<{ sent: number; failed: number }> {
  const { rows } = await sql<{
    id: number;
    to_email: string;
    template: string;
    payload: InvitationPayload;
    attempts: number;
  }>`
    update email_outbox set attempts = attempts + 1
    where id in (
      select id from email_outbox
      where status = 'pending' and attempts < ${MAX_ATTEMPTS}
      order by created_at
      limit ${BATCH}
      for update skip locked)
    returning id, to_email, template, payload, attempts`.execute(db);

  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      if (row.template !== "invitation") throw new Error(`Unknown email template ${row.template}`);
      await sender.send(invitationEmail(row.to_email, row.payload, appUrl));
      await db
        .updateTable("email_outbox")
        .set({ status: "sent", sent_at: new Date(), last_error: null })
        .where("id", "=", row.id)
        .execute();
      sent++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db
        .updateTable("email_outbox")
        .set({ last_error: message.slice(0, 1000), status: row.attempts >= MAX_ATTEMPTS ? "failed" : "pending" })
        .where("id", "=", row.id)
        .execute();
      log.warn({ emailId: row.id, attempts: row.attempts, err: message }, "email send failed");
      failed++;
    }
  }
  return { sent, failed };
}
