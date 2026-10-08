"use client";

import { INVITE_CSV_TEMPLATE } from "@hbe/core";
import { useActionState } from "react";
import { FormStatus } from "@/components/form-status";
import { Button, Field } from "@/components/ui";
import { importInvitations, inviteMember, updateMember } from "./actions";

const selectClass = "mt-1 block w-full rounded-md border border-border bg-surface px-3 py-2 text-sm";

export function InviteForm({
  slug,
  courses,
  fixedCourseId,
}: {
  slug: string;
  courses: { id: string; label: string }[];
  fixedCourseId?: string;
}) {
  const [state, action, pending] = useActionState(inviteMember, null);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="slug" value={slug} />
      <Field
        label="Email or GitHub username"
        name="identifier"
        required
        placeholder="ada@school.edu or octocat"
        autoComplete="off"
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="font-medium">Role in the institution</span>
          <select name="role" defaultValue="student" className={selectClass}>
            <option value="student">Student</option>
            <option value="teacher">Teacher</option>
            <option value="admin">Admin</option>
          </select>
        </label>
        {fixedCourseId ? (
          <input type="hidden" name="courseId" value={fixedCourseId} />
        ) : (
          <label className="block text-sm">
            <span className="font-medium">Course (optional)</span>
            <select name="courseId" defaultValue="" className={selectClass}>
              <option value="">No course</option>
              {courses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="block text-sm">
          <span className="font-medium">Role in the course</span>
          <select name="courseRole" defaultValue="" className={selectClass}>
            <option value="">Default for the role</option>
            <option value="student">Student</option>
            <option value="ta">Teaching assistant</option>
            <option value="instructor">Instructor</option>
          </select>
        </label>
      </div>
      <FormStatus state={state} />
      <Button type="submit" disabled={pending}>
        {pending ? "Inviting…" : "Send invitation"}
      </Button>
    </form>
  );
}

export function CsvImportForm({ slug }: { slug: string }) {
  const [state, action, pending] = useActionState(importInvitations, null);
  const template = `data:text/csv;charset=utf-8,${encodeURIComponent(INVITE_CSV_TEMPLATE)}`;
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="slug" value={slug} />
      <p className="text-sm text-muted">
        Columns: <code>email</code> or <code>github_login</code>, <code>role</code>, and optionally{" "}
        <code>course_code</code>, <code>course_term</code>, <code>course_role</code>.{" "}
        <a href={template} download="invitations-template.csv" className="text-accent hover:underline">
          Download a template
        </a>
        .
      </p>
      <label className="block text-sm">
        <span className="font-medium">CSV file</span>
        <input name="file" type="file" accept=".csv,text/csv" required className="mt-1 block w-full text-sm" />
      </label>
      <FormStatus state={state} />
      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? "Importing…" : "Import"}
      </Button>
    </form>
  );
}

export function MemberControls({ slug, id, role, status }: { slug: string; id: string; role: string; status: string }) {
  const [state, action, pending] = useActionState(updateMember, null);
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <form action={action} className="flex items-center gap-2">
          <input type="hidden" name="slug" value={slug} />
          <input type="hidden" name="id" value={id} />
          <select
            name="role"
            defaultValue={role}
            aria-label="Role"
            className="rounded-md border border-border bg-surface px-2 py-1 text-sm"
          >
            <option value="student">Student</option>
            <option value="teacher">Teacher</option>
            <option value="admin">Admin</option>
          </select>
          <Button type="submit" variant="secondary" disabled={pending} className="px-2.5 py-1">
            Save
          </Button>
        </form>
        <form action={action}>
          <input type="hidden" name="slug" value={slug} />
          <input type="hidden" name="id" value={id} />
          <input type="hidden" name="status" value={status === "active" ? "deactivated" : "active"} />
          <Button
            type="submit"
            variant={status === "active" ? "secondary" : "primary"}
            disabled={pending}
            className="px-2.5 py-1"
          >
            {status === "active" ? "Deactivate" : "Reactivate"}
          </Button>
        </form>
      </div>
      {state && <p className={`text-xs ${state.ok ? "text-success" : "text-danger"}`}>{state.message}</p>}
    </div>
  );
}
