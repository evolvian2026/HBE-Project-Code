import { sql } from "@hbe/db";
import Fastify from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { EmailMessage, EmailSender } from "../src/email/sender.ts";
import { drainEmailOutbox } from "../src/worker/email-outbox.ts";
import { Fixtures, testDb, unique } from "./helpers.ts";

const db = testDb();
const fixtures = new Fixtures(db);
const log = Fastify({ logger: false }).log;

class RecordingSender implements EmailSender {
  sent: EmailMessage[] = [];
  failFor = new Set<string>();
  async send(message: EmailMessage) {
    if (this.failFor.has(message.to)) throw new Error("provider down");
    this.sent.push(message);
  }
}

afterAll(async () => {
  await fixtures.cleanup();
  await db.destroy();
});

beforeEach(async () => {
  // Isolate from leftovers of other runs: park any other pending rows.
  await sql`update email_outbox set status = 'sent' where status = 'pending'`.execute(db);
});

describe("email outbox", () => {
  it("sends invitation emails queued by the database trigger", async () => {
    const inst = await fixtures.institution();
    const to = `invitee-${unique()}@test.local`;
    await db.insertInto("invitations").values({ institution_id: inst.id, email: to, role: "student" }).execute();

    const sender = new RecordingSender();
    const result = await drainEmailOutbox({ db, sender, appUrl: "https://app.example.com", log });

    expect(result).toEqual({ sent: 1, failed: 0 });
    expect(sender.sent[0]?.to).toBe(to);
    expect(sender.sent[0]?.subject).toBe(`You're invited to Test ${inst.slug} on HBE Projects`);
    expect(sender.sent[0]?.text).toContain("https://app.example.com/login");
    expect(sender.sent[0]?.text).toContain("Continue with GitHub");

    const again = await drainEmailOutbox({ db, sender, appUrl: "https://app.example.com", log });
    expect(again).toEqual({ sent: 0, failed: 0 });
  });

  it("retries failures and gives up after five attempts", async () => {
    const inst = await fixtures.institution();
    const to = `flaky-${unique()}@test.local`;
    await db.insertInto("invitations").values({ institution_id: inst.id, email: to, role: "teacher" }).execute();
    const sender = new RecordingSender();
    sender.failFor.add(to);

    for (let i = 0; i < 6; i++) await drainEmailOutbox({ db, sender, appUrl: "https://app.example.com", log });

    const row = await db.selectFrom("email_outbox").selectAll().where("to_email", "=", to).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: "failed", attempts: 5, last_error: "provider down" });
  });

  it("escapes institution names in the HTML body", async () => {
    const { invitationEmail } = await import("../src/email/templates.ts");
    const email = invitationEmail(
      "a@b.co",
      { institution_name: "<script>x</script> U", role: "admin" },
      "https://app.example.com",
    );
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&lt;script&gt;");
  });
});
