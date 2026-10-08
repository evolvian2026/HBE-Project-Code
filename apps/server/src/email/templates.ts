import type { EmailMessage } from "./sender.ts";

export interface InvitationPayload {
  institution_name: string;
  role: string;
  course_name?: string | null;
  course_role?: string | null;
  invited_by?: string | null;
  expires_at?: string | null;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const ROLE_LABEL: Record<string, string> = { admin: "an admin", teacher: "a teacher", student: "a student" };

export function invitationEmail(to: string, p: InvitationPayload, appUrl: string): EmailMessage {
  const loginUrl = new URL("/login", appUrl).toString();
  const what = p.course_name
    ? `${ROLE_LABEL[p.role] ?? p.role} at ${p.institution_name}, in ${p.course_name}`
    : `${ROLE_LABEL[p.role] ?? p.role} at ${p.institution_name}`;
  const by = p.invited_by ? `${p.invited_by} has invited you` : "You have been invited";
  const expires = p.expires_at ? new Date(p.expires_at).toUTCString().replace(" GMT", " UTC") : null;

  const lines = [
    `${by} to join HBE Projects as ${what}.`,
    "",
    `Sign in with this email address (${to}) to accept: ${loginUrl}`,
  ];
  if (p.role === "student") lines.push("Students: choose “Continue with GitHub” so your work is linked to you.");
  if (expires) lines.push("", `The invitation expires on ${expires}.`);
  const text = lines.join("\n");

  const html = `<p>${escapeHtml(by)} to join <strong>HBE Projects</strong> as ${escapeHtml(what)}.</p>
<p><a href="${escapeHtml(loginUrl)}">Sign in to accept</a> using this email address (${escapeHtml(to)}).</p>
${p.role === "student" ? "<p>Students: choose “Continue with GitHub” so your work is linked to you.</p>" : ""}
${expires ? `<p style="color:#5a6474">The invitation expires on ${escapeHtml(expires)}.</p>` : ""}`;

  return { to, subject: `You're invited to ${p.institution_name} on HBE Projects`, text, html };
}
