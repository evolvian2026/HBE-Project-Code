"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { ActionState } from "@/lib/actions";
import { apiFetch } from "@/lib/api";
import { requireMembership } from "@/lib/institution";

export type RegistrationState = (NonNullable<ActionState> & { url?: string; expiresAt?: string }) | null;

const field = (formData: FormData, name: string) => String(formData.get(name) ?? "").trim();

/** A one-time Dynamic Registration URL for the admin's LMS. */
export async function createRegistrationLink(_prev: RegistrationState, formData: FormData): Promise<RegistrationState> {
  const ctx = await requireMembership(field(formData, "slug"));
  const result = await apiFetch<{ url: string; expires_at: string }>(
    `/v1/institutions/${ctx.institution.id}/lti-registrations`,
    { method: "POST", body: { type: field(formData, "type"), name: field(formData, "name") } },
  );
  if (!result.ok) return { ok: false, message: result.message };
  return {
    ok: true,
    message: "Paste this URL into your LMS. It works once, for seven days.",
    url: result.data.url,
    expiresAt: result.data.expires_at,
  };
}

/** A connection entered by hand from the LMS's developer key or tool settings. */
export async function createConnection(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const slug = field(formData, "slug");
  const ctx = await requireMembership(slug);
  const deploymentIds = field(formData, "deploymentIds")
    .split(/[\s,]+/)
    .filter(Boolean);
  const result = await apiFetch(`/v1/institutions/${ctx.institution.id}/lms-connections`, {
    method: "POST",
    body: {
      type: field(formData, "type"),
      name: field(formData, "name"),
      issuer: field(formData, "issuer"),
      clientId: field(formData, "clientId"),
      deploymentIds,
      authLoginUrl: field(formData, "authLoginUrl"),
      authTokenUrl: field(formData, "authTokenUrl"),
      jwksUrl: field(formData, "jwksUrl"),
    },
  });
  if (!result.ok) return { ok: false, message: result.message };
  revalidatePath(`/i/${slug}/lms`);
  return { ok: true, message: "Connected. Launches from this LMS now sign people in." };
}

const back = (slug: string, params: Record<string, string>) =>
  `/i/${slug}/lms?${new URLSearchParams(params).toString()}`;

export async function setConnectionStatus(formData: FormData) {
  const { slug, connectionId, status } = z
    .object({ slug: z.string(), connectionId: z.string().uuid(), status: z.enum(["active", "disabled"]) })
    .parse(Object.fromEntries(formData));
  await requireMembership(slug);
  const result = await apiFetch(`/v1/lms-connections/${connectionId}`, { method: "PATCH", body: { status } });
  if (!result.ok) redirect(back(slug, { error: result.message }));
  revalidatePath(`/i/${slug}/lms`);
  redirect(back(slug, { done: status === "active" ? "Connection turned on." : "Connection turned off." }));
}

/** Links a waiting LMS user to a member, refuses them, or puts them back in the queue. */
export async function resolveLmsUser(formData: FormData) {
  const { slug, linkId, action, profileId } = z
    .object({
      slug: z.string(),
      linkId: z.string().uuid(),
      action: z.enum(["link", "reject", "reset"]),
      profileId: z.string().optional(),
    })
    .parse(Object.fromEntries(formData));
  await requireMembership(slug);
  if (action === "link" && !profileId) redirect(back(slug, { error: "Choose the member to link." }));
  const result = await apiFetch(`/v1/lms-user-links/${linkId}/resolve`, {
    method: "POST",
    body: action === "link" ? { action, profileId } : { action },
  });
  if (!result.ok) redirect(back(slug, { error: result.message }));
  revalidatePath(`/i/${slug}/lms`);
  const done = {
    link: "Linked. They can open the activity in the LMS again.",
    reject: "Their launches will be refused.",
    reset: "Back in the review queue.",
  }[action];
  redirect(back(slug, { done }));
}

export async function unlinkLmsCourse(formData: FormData) {
  const { slug, linkId } = z
    .object({ slug: z.string(), linkId: z.string().uuid() })
    .parse(Object.fromEntries(formData));
  await requireMembership(slug);
  const result = await apiFetch(`/v1/lms-course-links/${linkId}/unlink`, { method: "POST", body: {} });
  if (!result.ok) redirect(back(slug, { error: result.message }));
  revalidatePath(`/i/${slug}/lms`);
  redirect(back(slug, { done: "The LMS course is no longer linked." }));
}
