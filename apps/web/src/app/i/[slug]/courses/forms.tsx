"use client";

import { useActionState } from "react";
import { FormStatus } from "@/components/form-status";
import { Button, Field } from "@/components/ui";
import { addCourseMember, createCourse } from "./actions";

const selectClass = "mt-1 block w-full rounded-md border border-border bg-surface px-3 py-2 text-sm";

export function CreateCourseForm({
  slug,
  installations,
}: {
  slug: string;
  installations: { id: string; login: string }[];
}) {
  const [state, action, pending] = useActionState(createCourse, null);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="slug" value={slug} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Code" name="code" required maxLength={50} placeholder="CS101" />
        <div className="sm:col-span-2">
          <Field label="Name" name="name" required maxLength={200} placeholder="Web Development" />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Term" name="term" required maxLength={50} placeholder="2026-T1" />
        <label className="block text-sm">
          <span className="font-medium">GitHub organisation</span>
          <select name="githubInstallationId" defaultValue={installations[0]?.id ?? ""} className={selectClass}>
            <option value="">Choose later</option>
            {installations.map((i) => (
              <option key={i.id} value={i.id}>
                {i.login}
              </option>
            ))}
          </select>
        </label>
      </div>
      <FormStatus state={state} />
      <Button type="submit" disabled={pending}>
        {pending ? "Creating…" : "Create course"}
      </Button>
    </form>
  );
}

export function AddCourseMemberForm({
  slug,
  courseId,
  candidates,
}: {
  slug: string;
  courseId: string;
  candidates: { userId: string; label: string; role: string }[];
}) {
  const [state, action, pending] = useActionState(addCourseMember, null);
  if (candidates.length === 0)
    return <p className="text-sm text-muted">Everyone in the institution is already in this course.</p>;
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="courseId" value={courseId} />
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="font-medium">Person</span>
          <select name="userId" required className={selectClass}>
            {candidates.map((c) => (
              <option key={c.userId} value={c.userId}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="font-medium">Role in the course</span>
          <select name="role" defaultValue="student" className={selectClass}>
            <option value="student">Student</option>
            <option value="ta">Teaching assistant</option>
            <option value="instructor">Instructor</option>
          </select>
        </label>
      </div>
      <FormStatus state={state} />
      <Button type="submit" variant="secondary" disabled={pending}>
        Add to course
      </Button>
    </form>
  );
}
