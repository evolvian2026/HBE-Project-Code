import { sql } from "@hbe/db";
import Fastify from "fastify";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { SendEmailCommand } from "@aws-sdk/client-sesv2";
import {
  ResendEmailSender,
  SesEmailSender,
  SmtpEmailSender,
  type EmailMessage,
  type EmailSender,
} from "../src/email/sender.ts";
import { notify } from "../src/notifications.ts";
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

  it("emails notifications of the types each user wants", async () => {
    const to = `student-${unique()}@test.local`;
    const student = await fixtures.user({ email: to });
    const inst = await fixtures.institution([{ userId: student, role: "student" }]);
    const n = (type: "grade_released" | "run_finished", key: string) =>
      notify(db, {
        institutionId: inst.id,
        userId: student,
        type,
        title: type === "grade_released" ? "Your grade for Todo API is out" : "Test results for Todo API: 3/4 passed",
        body: "See your grade, rubric scores & feedback.",
        link: `/i/${inst.slug}/courses/c/assignments/a`,
        dedupeKey: key,
      });
    await n("grade_released", `g-${unique()}`);
    await n("run_finished", `r-${unique()}`); // in-app only by default

    const sender = new RecordingSender();
    expect(await drainEmailOutbox({ db, sender, appUrl: "https://app.example.com", log })).toEqual({
      sent: 1,
      failed: 0,
    });
    const [email] = sender.sent;
    expect(email).toMatchObject({ to, subject: "Your grade for Todo API is out" });
    expect(email!.text).toContain(`Open: https://app.example.com/i/${inst.slug}/courses/c/assignments/a`);
    expect(email!.text).toContain("https://app.example.com/account/notifications");
    expect(email!.html).toContain("rubric scores &amp; feedback");
    expect(email!.headers?.["List-Unsubscribe"]).toBe("<https://app.example.com/account/notifications>");

    // Users choose: test results by email, grades not.
    await db
      .updateTable("profiles")
      .set({ email_notification_types: ["run_finished"] })
      .where("id", "=", student)
      .execute();
    await n("grade_released", `g-${unique()}`);
    await n("run_finished", `r-${unique()}`);
    await drainEmailOutbox({ db, sender, appUrl: "https://app.example.com", log });
    expect(sender.sent.map((m) => m.subject)).toEqual([
      "Your grade for Todo API is out",
      "Test results for Todo API: 3/4 passed",
    ]);

    // Nothing is emailed for a suspended institution.
    await db.updateTable("institutions").set({ status: "suspended" }).where("id", "=", inst.id).execute();
    await n("run_finished", `r-${unique()}`);
    expect((await drainEmailOutbox({ db, sender, appUrl: "https://app.example.com", log })).sent).toBe(0);
  });
});

describe("email senders", () => {
  const message: EmailMessage = {
    to: "ada@test.local",
    subject: "Your grade for Todo API is out",
    text: "Plain",
    html: "<p>Html</p>",
    headers: { "List-Unsubscribe": "<https://app.example.com/account/notifications>" },
  };

  it("deliver over SMTP (local Mailpit)", async () => {
    const mailpit = process.env.MAILPIT_URL ?? "http://127.0.0.1:54324";
    const to = `smtp-${unique()}@test.local`;
    await new SmtpEmailSender(process.env.SMTP_URL ?? "smtp://127.0.0.1:54325", "HBE <no-reply@test.local>").send({
      ...message,
      to,
    });
    const found = (await (
      await fetch(`${mailpit}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`)
    ).json()) as { messages: { Subject: string; From: { Address: string } }[] };
    expect(found.messages[0]).toMatchObject({
      Subject: "Your grade for Todo API is out",
      From: { Address: "no-reply@test.local" },
    });
  });

  it("call Resend's API", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: "re_1" }), { status: 200 });
    }) as unknown as typeof fetch;
    await new ResendEmailSender("re_key", "HBE <no-reply@example.com>", fakeFetch).send(message);
    expect(calls[0]!.url).toBe("https://api.resend.com/emails");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      from: "HBE <no-reply@example.com>",
      to: ["ada@test.local"],
      subject: message.subject,
      text: "Plain",
      html: "<p>Html</p>",
      headers: message.headers,
    });

    const failing = (async () => new Response("bad from", { status: 422 })) as unknown as typeof fetch;
    await expect(new ResendEmailSender("re_key", "x", failing).send(message)).rejects.toThrow("Resend responded 422");
  });

  it("call SES", async () => {
    const sent: SendEmailCommand[] = [];
    const client = { send: async (cmd: SendEmailCommand) => void sent.push(cmd) };
    await new SesEmailSender(client as never, "no-reply@example.com").send(message);
    expect(sent[0]!.input).toMatchObject({
      FromEmailAddress: "no-reply@example.com",
      Destination: { ToAddresses: ["ada@test.local"] },
      Content: {
        Simple: {
          Subject: { Data: message.subject },
          Headers: [{ Name: "List-Unsubscribe", Value: "<https://app.example.com/account/notifications>" }],
        },
      },
    });
  });
});
