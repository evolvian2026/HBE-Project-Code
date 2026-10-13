import { Alert, Badge, Button, Card, Field } from "@/components/ui";
import { webConfig } from "@/lib/config";
import { disableSso, requestSso, setSsoJoin } from "./sso-actions";

export interface SsoConnection {
  status: "pending" | "active" | "rejected" | "disabled";
  domains: string[];
  metadata_url: string | null;
  join_as_student: boolean;
  review_note: string | null;
}

const STATUS = {
  pending: { label: "waiting for the platform operator", tone: "warning" },
  active: { label: "on", tone: "success" },
  rejected: { label: "declined", tone: "danger" },
  disabled: { label: "off", tone: "neutral" },
} as const;

/** Institution admins: single sign-on with their identity provider (SAML). */
export function SsoCard({
  slug,
  connection,
  available,
  query,
}: {
  slug: string;
  connection: SsoConnection | null;
  available: boolean;
  query: Record<string, string | undefined>;
}) {
  const { SUPABASE_URL } = webConfig();
  const sp = `${SUPABASE_URL.replace(/\/$/, "")}/auth/v1/sso/saml`;
  const editable = !connection || connection.status !== "active";
  return (
    <section id="sso">
      <Card
        title="Single sign-on"
        description="People sign in with their institution account (SAML 2.0: Microsoft Entra ID, Okta, Google Workspace, Shibboleth…)."
      >
        <div className="space-y-4 text-sm">
          {query.sso_error && <Alert tone="error">{query.sso_error}</Alert>}
          {query.sso && <Alert tone="success">{query.sso}</Alert>}
          {!available ? (
            <p className="text-muted">Single sign-on is part of the paid plan. Ask the platform operator.</p>
          ) : (
            <>
              {connection && (
                <p className="flex flex-wrap items-center gap-2" data-testid="sso-status">
                  <Badge tone={STATUS[connection.status].tone}>{STATUS[connection.status].label}</Badge>
                  for {connection.domains.join(", ")}
                  {connection.review_note && <span className="text-muted">· “{connection.review_note}”</span>}
                </p>
              )}
              <div className="rounded-md border border-border p-3 text-xs">
                <p className="mb-1 font-medium">For your identity provider</p>
                <p>
                  Entity ID and metadata: <code className="break-all">{sp}/metadata</code>
                </p>
                <p>
                  Reply (ACS) URL: <code className="break-all">{sp}/acs</code>
                </p>
                <p className="mt-1 text-muted">
                  Send the email address as the NameID (format emailAddress) or an &ldquo;email&rdquo; attribute.
                </p>
              </div>
              {editable ? (
                <form action={requestSso} className="space-y-3">
                  <input type="hidden" name="slug" value={slug} />
                  <Field
                    label="Email domains"
                    name="domains"
                    required
                    defaultValue={connection?.domains.join(", ") ?? ""}
                    placeholder="uni.edu.sg, students.uni.edu.sg"
                    hint="Everyone with an address in these domains signs in through your identity provider."
                  />
                  <Field
                    label="Identity provider metadata URL"
                    name="metadataUrl"
                    type="url"
                    defaultValue={connection?.metadata_url ?? ""}
                    placeholder="https://login.uni.edu.sg/saml/metadata"
                  />
                  <label className="block">
                    <span className="font-medium">…or its metadata file (XML)</span>
                    <textarea
                      name="metadataXml"
                      rows={4}
                      className="mt-1 block w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs"
                      placeholder="<md:EntityDescriptor …>"
                    />
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" name="joinAsStudent" defaultChecked={connection?.join_as_student ?? false} />
                    People from these domains who sign in join as students (without an invitation)
                  </label>
                  <p className="text-xs text-muted">
                    The platform operator turns it on after checking your institution owns these domains.
                  </p>
                  <Button type="submit" variant="secondary">
                    {connection?.status === "pending" ? "Update request" : "Ask to turn it on"}
                  </Button>
                </form>
              ) : (
                <div className="flex flex-wrap items-center gap-3">
                  <form action={setSsoJoin} className="flex items-center gap-2">
                    <input type="hidden" name="slug" value={slug} />
                    <input type="hidden" name="joinAsStudent" value={connection.join_as_student ? "" : "on"} />
                    <span>
                      {connection.join_as_student
                        ? "People from these domains join as students when they first sign in."
                        : "Only invited people join."}
                    </span>
                    <Button type="submit" variant="secondary" className="px-2 py-1 text-xs">
                      {connection.join_as_student ? "Invited people only" : "Let them join as students"}
                    </Button>
                  </form>
                  <form action={disableSso}>
                    <input type="hidden" name="slug" value={slug} />
                    <Button type="submit" variant="danger" className="px-2 py-1 text-xs">
                      Turn off single sign-on
                    </Button>
                  </form>
                </div>
              )}
            </>
          )}
        </div>
      </Card>
    </section>
  );
}
