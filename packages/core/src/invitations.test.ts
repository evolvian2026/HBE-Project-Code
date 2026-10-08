import { describe, expect, it } from "vitest";
import { parseCsv } from "./csv.ts";
import { parseInviteCsv, planInvitations, type PlanContext } from "./invitations.ts";

describe("parseCsv", () => {
  it("handles quotes, embedded commas and newlines, CRLF and a BOM", () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\n"multi\nline",z\n\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
      ["multi\nline", "z"],
    ]);
  });
  it("keeps empty fields", () => {
    expect(parseCsv("a,,c")).toEqual([["a", "", "c"]]);
  });
});

describe("parseInviteCsv", () => {
  it("maps headers case-insensitively and numbers lines from the header", () => {
    const { rows, errors } = parseInviteCsv("Email,Role,Course Code\nada@x.edu,student,CS101\n");
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      {
        line: 2,
        email: "ada@x.edu",
        role: "student",
        courseCode: "CS101",
        githubLogin: undefined,
        courseTerm: undefined,
        courseRole: undefined,
      },
    ]);
  });
  it("reports missing columns", () => {
    expect(parseInviteCsv("name,role\nAda,student").errors[0]?.message).toMatch(/email or github_login/);
    expect(parseInviteCsv("email\na@b.co").errors[0]?.message).toMatch(/role/);
  });
});

const ctx: PlanContext = {
  members: [
    { userId: "u-teacher", email: "grace@x.edu", githubLogin: "grace-h", status: "active" },
    { userId: "u-gone", email: "gone@x.edu", githubLogin: null, status: "deactivated" },
  ],
  pendingInvitations: [{ email: "waiting@x.edu", githubLogin: null, courseId: null }],
  courses: [
    { id: "c1", code: "CS101", term: "2026-T1", archived: false },
    { id: "c2", code: "CS201", term: "2026-T1", archived: false },
    { id: "c3", code: "CS201", term: "2026-T2", archived: false },
    { id: "c4", code: "OLD1", term: "2025-T1", archived: true },
  ],
  courseMembers: [{ courseId: "c2", userId: "u-teacher" }],
};

describe("planInvitations", () => {
  it("invites new people, defaulting the course role from the institution role", () => {
    const plan = planInvitations(
      [
        { line: 2, email: " Ada@X.edu ", role: "Student", courseCode: "cs101" },
        { line: 3, githubLogin: "@octocat", role: "teacher", courseCode: "CS101" },
      ],
      ctx,
    );
    expect(plan.errors).toEqual([]);
    expect(plan.invitations).toEqual([
      { email: "ada@x.edu", github_login: null, role: "student", course_id: "c1", course_role: "student" },
      { email: null, github_login: "octocat", role: "teacher", course_id: "c1", course_role: "instructor" },
    ]);
  });

  it("enrols existing members in a course instead of inviting them", () => {
    const plan = planInvitations(
      [{ line: 2, githubLogin: "GRACE-H", role: "teacher", courseCode: "CS101", courseRole: "ta" }],
      ctx,
    );
    expect(plan.invitations).toEqual([]);
    expect(plan.courseMemberships).toEqual([{ course_id: "c1", user_id: "u-teacher", role: "ta" }]);
  });

  it("skips what is already done", () => {
    const plan = planInvitations(
      [
        { line: 2, email: "grace@x.edu", role: "teacher" },
        { line: 3, email: "grace@x.edu", role: "teacher", courseCode: "CS201", courseTerm: "2026-T1" },
        { line: 4, email: "waiting@x.edu", role: "student" },
        { line: 5, email: "new@x.edu", role: "student" },
        { line: 6, email: "NEW@x.edu", role: "student" },
      ],
      ctx,
    );
    expect(plan.skipped.map((s) => s.reason)).toEqual([
      "already a member",
      "already in the course",
      "already invited",
      "duplicate row",
    ]);
    expect(plan.invitations).toHaveLength(1);
  });

  it("reports invalid rows with their line numbers", () => {
    const plan = planInvitations(
      [
        { line: 2, role: "student" },
        { line: 3, email: "nope", role: "student" },
        { line: 4, email: "a@x.edu", role: "owner" },
        { line: 5, email: "b@x.edu", role: "student", courseCode: "CS201" },
        { line: 6, email: "c@x.edu", role: "student", courseCode: "OLD1" },
        { line: 7, email: "gone@x.edu", role: "student" },
        { line: 8, email: "d@x.edu", role: "student", courseCode: "CS101", courseRole: "boss" },
        { line: 9, githubLogin: "bad login!", role: "student" },
      ],
      ctx,
    );
    expect(plan.errors.map((e) => e.line)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(plan.errors[3]?.message).toMatch(/several terms/);
    expect(plan.invitations).toEqual([]);
  });
});
