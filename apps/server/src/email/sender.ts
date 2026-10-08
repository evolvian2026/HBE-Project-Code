import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import type { Settings } from "@hbe/settings";
import type { FastifyBaseLogger } from "fastify";
import nodemailer, { type Transporter } from "nodemailer";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Extra headers, e.g. List-Unsubscribe. */
  headers?: Record<string, string>;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/** Local development: write the email to the log instead of sending it. */
export class LogEmailSender implements EmailSender {
  constructor(private readonly log: FastifyBaseLogger) {}
  async send(message: EmailMessage): Promise<void> {
    this.log.info(
      { to: message.to, subject: message.subject, text: message.text },
      "email (not sent: EMAIL_PROVIDER=log)",
    );
  }
}

/** Resend's HTTP API (works on Render free, which blocks outbound SMTP). */
export class ResendEmailSender implements EmailSender {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  async send(message: EmailMessage): Promise<void> {
    const res = await this.fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: this.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        html: message.html,
        ...(message.headers && { headers: message.headers }),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Resend responded ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
}

/** Any SMTP server: Mailpit in local development, or a relay (Postmark, SES SMTP, …). */
export class SmtpEmailSender implements EmailSender {
  private readonly transport: Transporter;
  constructor(
    url: string,
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport({ url, connectionTimeout: 10_000, socketTimeout: 15_000 });
  }
  async send(message: EmailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.from, ...message });
  }
}

/** Amazon SES (API v2); credentials from the default chain, e.g. the EC2 instance role. */
export class SesEmailSender implements EmailSender {
  constructor(
    private readonly client: Pick<SESv2Client, "send">,
    private readonly from: string,
  ) {}
  async send(message: EmailMessage): Promise<void> {
    await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: this.from,
        Destination: { ToAddresses: [message.to] },
        Content: {
          Simple: {
            Subject: { Data: message.subject, Charset: "UTF-8" },
            Body: { Text: { Data: message.text, Charset: "UTF-8" }, Html: { Data: message.html, Charset: "UTF-8" } },
            Headers: Object.entries(message.headers ?? {}).map(([Name, Value]) => ({ Name, Value })),
          },
        },
      }),
    );
  }
}

export function createEmailSender(settings: Settings, log: FastifyBaseLogger): EmailSender {
  const { EMAIL_PROVIDER, RESEND_API_KEY, EMAIL_FROM, SMTP_URL, AWS_SES_REGION } = settings.env;
  switch (EMAIL_PROVIDER) {
    case "log":
      return new LogEmailSender(log);
    case "resend":
      return new ResendEmailSender(RESEND_API_KEY!, EMAIL_FROM!);
    case "smtp":
      return new SmtpEmailSender(SMTP_URL!, EMAIL_FROM!);
    case "ses":
      return new SesEmailSender(new SESv2Client({ region: AWS_SES_REGION! }), EMAIL_FROM!);
  }
}
