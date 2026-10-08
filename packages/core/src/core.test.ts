import { describe, expect, it } from "vitest";
import { allowed, authorize, ForbiddenError, type Actor } from "./permissions.ts";
import { SLUG_PATTERN, slugify } from "./slug.ts";

const actor = (over: Partial<Actor> = {}): Actor => ({
  userId: "u1",
  isSuperAdmin: false,
  mfaSatisfied: true,
  githubUserId: null,
  memberships: new Map(),
  ...over,
});

describe("permissions", () => {
  const admin = actor({ memberships: new Map([["inst-a", { role: "admin", institutionStatus: "active" }]]) });
  const teacher = actor({ memberships: new Map([["inst-a", { role: "teacher", institutionStatus: "active" }]]) });
  const readOnlyAdmin = actor({
    memberships: new Map([["inst-a", { role: "admin", institutionStatus: "read_only" }]]),
  });

  it("only super admins create institutions", () => {
    expect(allowed(actor({ isSuperAdmin: true }), "createInstitution")).toBe(true);
    expect(allowed(admin, "createInstitution")).toBe(false);
  });

  it("institution admins manage only their own active institution", () => {
    expect(allowed(admin, "manageInstitution", "inst-a")).toBe(true);
    expect(allowed(admin, "manageInstitution", "inst-b")).toBe(false);
    expect(allowed(teacher, "manageInstitution", "inst-a")).toBe(false);
    expect(allowed(readOnlyAdmin, "manageInstitution", "inst-a")).toBe(false);
  });

  it("super admins can invite an institution's admins without being a member", () => {
    expect(allowed(actor({ isSuperAdmin: true }), "inviteInstitutionAdmin", "inst-b")).toBe(true);
  });

  it("admins without MFA have no admin powers", () => {
    const noMfa = { ...admin, mfaSatisfied: false };
    expect(allowed(noMfa, "manageInstitution", "inst-a")).toBe(false);
    expect(allowed(noMfa, "inviteInstitutionAdmin", "inst-a")).toBe(false);
  });

  it("authorize throws a 403 error", () => {
    expect(() => authorize(teacher, "linkGithubInstallation", "inst-a")).toThrow(ForbiddenError);
  });
});

describe("slugify", () => {
  it.each([
    ["Alpha University", "alpha-university"],
    ["  École Polytechnique!! ", "ecole-polytechnique"],
    ["NUS — School of Computing", "nus-school-of-computing"],
  ])("%s → %s", (name, slug) => {
    expect(slugify(name)).toBe(slug);
    expect(SLUG_PATTERN.test(slug)).toBe(true);
  });

  it("never ends with a hyphen after truncation", () => {
    const slug = slugify(`${"a".repeat(49)} b`);
    expect(SLUG_PATTERN.test(slug)).toBe(true);
  });
});
