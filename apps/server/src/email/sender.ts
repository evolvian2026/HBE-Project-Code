import type { Settings } from "@hbe/settings";
import type { FastifyBaseLogger } from "fastify";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
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
  ) {}
  async send(message: EmailMessage): Promise<void> {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: this.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        html: message.html,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Resend responded ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
}

export function createEmailSender(settings: Settings, log: FastifyBaseLogger): EmailSender {
  const { EMAIL_PROVIDER, RESEND_API_KEY, EMAIL_FROM } = settings.env;
  switch (EMAIL_PROVIDER) {
    case "log":
      return new LogEmailSender(log);
    case "resend":
      return new ResendEmailSender(RESEND_API_KEY!, EMAIL_FROM!);
    case "ses":
      throw new Error("EMAIL_PROVIDER=ses is not supported yet; use resend");
  }
}
