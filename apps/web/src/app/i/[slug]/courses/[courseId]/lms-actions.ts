"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { apiFetch } from "@/lib/api";
import { requireMembership } from "@/lib/institution";

/** Reads an LMS course's roster now (it is also read every night). */
export async function syncLmsRoster(formData: FormData) {
  const { slug, courseId, linkId } = z
    .object({ slug: z.string(), courseId: z.string().uuid(), linkId: z.string().uuid() })
    .parse(Object.fromEntries(formData));
  await requireMembership(slug);
  const page = `/i/${slug}/courses/${courseId}`;
  const result = await apiFetch(`/v1/lms-course-links/${linkId}/roster-sync`, { method: "POST", body: {} });
  if (!result.ok) redirect(`${page}?roster_error=${encodeURIComponent(result.message)}#lms`);
  redirect(`${page}?roster=${Date.now()}#lms`);
}

const ids = z.object({ slug: z.string(), courseId: z.string().uuid(), institutionId: z.string().uuid() });

/** Sends the teacher to Google to let the platform use their Classroom classes. */
export async function connectGoogle(formData: FormData) {
  const { slug, courseId, institutionId } = ids.parse(Object.fromEntries(formData));
  await requireMembership(slug);
  const page = `/i/${slug}/courses/${courseId}`;
  const result = await apiFetch<{ url: string }>(`/v1/institutions/${institutionId}/google/connect`, {
    method: "POST",
    body: { next: page },
  });
  if (!result.ok) redirect(`${page}?google_error=${encodeURIComponent(result.message)}#classroom`);
  redirect(result.data.url);
}

export async function disconnectGoogle(formData: FormData) {
  const { slug, courseId, institutionId } = ids.parse(Object.fromEntries(formData));
  await requireMembership(slug);
  await apiFetch(`/v1/institutions/${institutionId}/google`, { method: "DELETE" });
  redirect(`/i/${slug}/courses/${courseId}#classroom`);
}

/** Links one of the teacher's Classroom classes to this course. */
export async function linkClassroomClass(formData: FormData) {
  const { slug, courseId } = ids.parse(Object.fromEntries(formData));
  await requireMembership(slug);
  const classId = String(formData.get("classId") ?? "");
  const page = `/i/${slug}/courses/${courseId}`;
  if (!classId) redirect(`${page}?google_error=${encodeURIComponent("Choose a class.")}#classroom`);
  const result = await apiFetch(`/v1/courses/${courseId}/classroom-links`, { method: "POST", body: { classId } });
  if (!result.ok) redirect(`${page}?google_error=${encodeURIComponent(result.message)}#classroom`);
  redirect(`${page}?roster=${Date.now()}#classroom`);
}
