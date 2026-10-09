/** LTI 1.3 / LTI Advantage claim names and vocabularies (IMS Global specs). */
export const CLAIM = {
  messageType: "https://purl.imsglobal.org/spec/lti/claim/message_type",
  version: "https://purl.imsglobal.org/spec/lti/claim/version",
  deploymentId: "https://purl.imsglobal.org/spec/lti/claim/deployment_id",
  targetLinkUri: "https://purl.imsglobal.org/spec/lti/claim/target_link_uri",
  resourceLink: "https://purl.imsglobal.org/spec/lti/claim/resource_link",
  roles: "https://purl.imsglobal.org/spec/lti/claim/roles",
  context: "https://purl.imsglobal.org/spec/lti/claim/context",
  custom: "https://purl.imsglobal.org/spec/lti/claim/custom",
  toolPlatform: "https://purl.imsglobal.org/spec/lti/claim/tool_platform",
  launchPresentation: "https://purl.imsglobal.org/spec/lti/claim/launch_presentation",
  nrps: "https://purl.imsglobal.org/spec/lti-nrps/claim/namesroleservice",
  ags: "https://purl.imsglobal.org/spec/lti-ags/claim/endpoint",
  deepLinkingSettings: "https://purl.imsglobal.org/spec/lti-dl/claim/deep_linking_settings",
  deepLinkingContentItems: "https://purl.imsglobal.org/spec/lti-dl/claim/content_items",
  deepLinkingData: "https://purl.imsglobal.org/spec/lti-dl/claim/data",
} as const;

export const SCOPE = {
  lineItem: "https://purl.imsglobal.org/spec/lti-ags/scope/lineitem",
  lineItemReadOnly: "https://purl.imsglobal.org/spec/lti-ags/scope/lineitem.readonly",
  score: "https://purl.imsglobal.org/spec/lti-ags/scope/score",
  resultReadOnly: "https://purl.imsglobal.org/spec/lti-ags/scope/result.readonly",
  nrps: "https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly",
} as const;

export type CourseRole = "instructor" | "ta" | "student";

/**
 * The course role an LMS role list means here: instructors (and content developers) teach,
 * teaching assistants assist, learners study. Unknown roles map to nothing.
 */
export function courseRoleFromLti(roles: readonly string[]): CourseRole | null {
  const has = (suffix: string) => roles.some((r) => r === suffix || r.endsWith(`/membership#${suffix}`));
  if (roles.some((r) => r.endsWith("/membership/Instructor#TeachingAssistant"))) return "ta";
  if (has("Instructor") || has("ContentDeveloper")) return "instructor";
  if (has("Learner")) return "student";
  return null;
}

/** Whether the roles include an institution or system administrator. */
export const isLmsAdministrator = (roles: readonly string[]) =>
  roles.some((r) => /\/(institution|system)\/person#Administrator$/.test(r));
