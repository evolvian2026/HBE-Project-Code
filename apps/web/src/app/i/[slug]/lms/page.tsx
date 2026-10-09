import { formatInZone } from "@hbe/core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Alert, Badge, Button, Card, EmptyState } from "@/components/ui";
import { webConfig } from "@/lib/config";
import { requireMembership } from "@/lib/institution";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { loadMembers } from "../members/data";
import { resolveLmsUser, setConnectionStatus, setGoogleClassroom, unlinkLmsCourse } from "./actions";
import { ManualConnectionForm, RegistrationLinkForm } from "./forms";

export const metadata: Metadata = { title: "LMS" };

const TYPE_LABEL = { canvas: "Canvas", moodle: "Moodle", lti: "LTI 1.3", google_classroom: "Google Classroom" };
const selectClass = "rounded-md border border-border bg-surface px-2 py-1.5 text-sm";

interface Connection {
  id: string;
  type: keyof typeof TYPE_LABEL;
  name: string;
  status: "active" | "disabled";
  issuer: string | null;
  client_id: string | null;
  deployment_ids: string[];
  registered_by: "manual" | "dynamic";
  created_at: string;
}

interface UserLink {
  id: string;
  lms_connection_id: string;
  lms_user_id: string;
  email: string | null;
  name: string | null;
  status: "linked" | "pending" | "rejected";
  last_launch_at: string | null;
}

interface CourseLink {
  id: string;
  lms_connection_id: string;
  context_id: string;
  context_title: string | null;
  course: { id: string; code: string; name: string } | null;
}

function Endpoint({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[14rem_1fr]">
      <dt className="text-muted">{label}</dt>
      <dd className="font-mono text-xs break-all">{value}</dd>
    </div>
  );
}

export default async function LmsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const ctx = await requireMembership(slug);
  if (!ctx.isAdmin) notFound();
  const supabase = await createSupabaseServerClient();
  const [connections, userLinks, courseLinks, members, googleAccounts] = await Promise.all([
    supabase
      .from("lms_connections")
      .select("id, type, name, status, issuer, client_id, deployment_ids, registered_by, created_at")
      .eq("institution_id", ctx.institution.id)
      .order("created_at"),
    supabase
      .from("lms_user_links")
      .select("id, lms_connection_id, lms_user_id, email, name, status, last_launch_at")
      .eq("institution_id", ctx.institution.id)
      .neq("status", "linked")
      .order("last_launch_at", { ascending: false })
      .limit(200),
    supabase
      .from("lms_course_links")
      .select("id, lms_connection_id, context_id, context_title, course:courses(id, code, name)")
      .eq("institution_id", ctx.institution.id)
      .order("created_at", { ascending: false })
      .limit(200),
    loadMembers(supabase, ctx.institution.id),
    supabase
      .from("google_accounts")
      .select("id, profile_id, email, connected_at, revoked_at")
      .eq("institution_id", ctx.institution.id)
      .order("connected_at"),
  ]);
  const allConns = (connections.data ?? []) as Connection[];
  const conns = allConns.filter((c) => c.type !== "google_classroom");
  const classroom = allConns.find((c) => c.type === "google_classroom");
  const teachers = (googleAccounts.data ?? []) as {
    id: string;
    profile_id: string;
    email: string | null;
    connected_at: string;
    revoked_at: string | null;
  }[];
  const memberName = new Map(members.map((m) => [m.user_id, m.profile?.full_name ?? m.profile?.email ?? ""]));
  const connName = new Map(allConns.map((c) => [c.id, c.name]));
  const waiting = (userLinks.data ?? []) as UserLink[];
  const courses = (courseLinks.data ?? []) as unknown as CourseLink[];
  const activeMembers = members.filter((m) => m.status === "active");
  const base = webConfig().API_URL.replace(/\/$/, "");
  const tz = "Asia/Singapore";
  const writable = ctx.writable;

  return (
    <div className="max-w-4xl space-y-6">
      {query.error && <Alert tone="error">{query.error}</Alert>}
      {query.done && <Alert tone="success">{query.done}</Alert>}

      <Card
        title="LMS connections"
        description="Launches from a connected LMS (Canvas, Moodle or another LTI 1.3 platform) sign people in and take them to their course."
      >
        {conns.length === 0 ? (
          <EmptyState title="No LMS connected yet">Connect one below.</EmptyState>
        ) : (
          <ul className="divide-y divide-border text-sm" data-testid="lms-connections">
            {conns.map((c) => (
              <li key={c.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                <div className="min-w-0 space-y-0.5">
                  <p className="font-medium">
                    {c.name} <Badge tone="neutral">{TYPE_LABEL[c.type]}</Badge>{" "}
                    {c.status === "disabled" && <Badge tone="warning">off</Badge>}
                  </p>
                  <p className="text-xs break-all text-muted">
                    {c.issuer} · client {c.client_id}
                    {c.deployment_ids.length > 0 && ` · deployments ${c.deployment_ids.join(", ")}`} ·{" "}
                    {c.registered_by === "dynamic" ? "registered automatically" : "entered by hand"}
                  </p>
                </div>
                {writable && (
                  <form action={setConnectionStatus}>
                    <input type="hidden" name="slug" value={slug} />
                    <input type="hidden" name="connectionId" value={c.id} />
                    <input type="hidden" name="status" value={c.status === "active" ? "disabled" : "active"} />
                    <Button type="submit" variant="secondary">
                      {c.status === "active" ? "Turn off" : "Turn on"}
                    </Button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="Google Classroom"
        description="Teachers connect their own Google account on their course pages, link their classes, and post assignments there; released grades follow."
        actions={
          writable && (
            <form action={setGoogleClassroom}>
              <input type="hidden" name="slug" value={slug} />
              <input type="hidden" name="enabled" value={classroom?.status === "active" ? "false" : "true"} />
              <Button type="submit" variant={classroom?.status === "active" ? "secondary" : "primary"}>
                {classroom?.status === "active" ? "Turn off" : "Turn on Google Classroom"}
              </Button>
            </form>
          )
        }
      >
        {classroom?.status !== "active" ? (
          <p className="text-sm text-muted">Off.</p>
        ) : teachers.length === 0 ? (
          <p className="text-sm text-muted">On. No teacher has connected a Google account yet.</p>
        ) : (
          <ul className="divide-y divide-border text-sm" data-testid="google-accounts">
            {teachers.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  {memberName.get(t.profile_id) || t.email}
                  <span className="text-muted"> · {t.email}</span>
                </span>
                {t.revoked_at ? (
                  <Badge tone="warning">access expired</Badge>
                ) : (
                  <span className="text-xs text-muted">connected {formatInZone(t.connected_at, tz)}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {writable && (
        <Card
          title="Connect an LMS"
          description="The quickest way: create a one-time registration URL and paste it into your LMS (Canvas: Admin → Developer Keys → + Developer Key → LTI Registration; Moodle: Site administration → Plugins → Manage tools → Tool URL)."
        >
          <RegistrationLinkForm slug={slug} />
          <details className="mt-5 rounded-md border border-border p-3">
            <summary className="cursor-pointer text-sm font-medium">Or enter the details by hand</summary>
            <div className="mt-3 space-y-4">
              <p className="text-sm text-muted">Give your LMS these tool details:</p>
              <dl className="space-y-2 text-sm" data-testid="tool-endpoints">
                <Endpoint label="Login (initiation) URL" value={`${base}/lti/login`} />
                <Endpoint label="Redirect / target link URI" value={`${base}/lti/launch`} />
                <Endpoint label="Public keyset (JWKS) URL" value={`${base}/.well-known/jwks.json`} />
              </dl>
              <p className="text-sm text-muted">Then copy what your LMS shows for the tool here:</p>
              <ManualConnectionForm slug={slug} />
            </div>
          </details>
        </Card>
      )}

      <Card
        title="LMS users to review"
        description="People who launched from your LMS but whose email didn't match a member or invitation. Link them to a member, or invite them under Members first."
      >
        {waiting.length === 0 ? (
          <EmptyState title="Nobody is waiting" />
        ) : (
          <ul className="divide-y divide-border text-sm" data-testid="lms-waiting">
            {waiting.map((u) => (
              <li key={u.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="font-medium">
                    {u.name ?? u.email ?? u.lms_user_id}{" "}
                    {u.status === "rejected" && <Badge tone="danger">refused</Badge>}
                  </p>
                  <p className="text-xs text-muted">
                    {u.email ?? "no email"} · {connName.get(u.lms_connection_id)}
                    {u.last_launch_at && ` · last launch ${formatInZone(u.last_launch_at, tz)}`}
                  </p>
                </div>
                {writable &&
                  (u.status === "pending" ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <form action={resolveLmsUser} className="flex items-center gap-2">
                        <input type="hidden" name="slug" value={slug} />
                        <input type="hidden" name="linkId" value={u.id} />
                        <input type="hidden" name="action" value="link" />
                        <select
                          name="profileId"
                          defaultValue=""
                          className={selectClass}
                          aria-label={`Member to link ${u.name ?? u.email ?? u.lms_user_id} to`}
                        >
                          <option value="">Choose a member…</option>
                          {activeMembers.map((m) => (
                            <option key={m.user_id} value={m.user_id}>
                              {m.profile?.full_name ?? m.profile?.email ?? m.profile?.github_login} ({m.role})
                            </option>
                          ))}
                        </select>
                        <Button type="submit" variant="secondary">
                          Link
                        </Button>
                      </form>
                      <form action={resolveLmsUser}>
                        <input type="hidden" name="slug" value={slug} />
                        <input type="hidden" name="linkId" value={u.id} />
                        <input type="hidden" name="action" value="reject" />
                        <Button type="submit" variant="secondary">
                          Refuse
                        </Button>
                      </form>
                    </div>
                  ) : (
                    <form action={resolveLmsUser}>
                      <input type="hidden" name="slug" value={slug} />
                      <input type="hidden" name="linkId" value={u.id} />
                      <input type="hidden" name="action" value="reset" />
                      <Button type="submit" variant="secondary">
                        Review again
                      </Button>
                    </form>
                  ))}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="LMS courses"
        description="Courses people have launched from. Instructors link them to a course here the first time they launch."
      >
        {courses.length === 0 ? (
          <EmptyState title="No launches yet" />
        ) : (
          <ul className="divide-y divide-border text-sm" data-testid="lms-courses">
            {courses.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="font-medium">{l.context_title ?? l.context_id}</p>
                  <p className="text-xs text-muted">
                    {connName.get(l.lms_connection_id)} ·{" "}
                    {l.course ? (
                      <a href={`/i/${slug}/courses/${l.course.id}`} className="text-accent hover:underline">
                        {l.course.code} {l.course.name}
                      </a>
                    ) : (
                      "not linked"
                    )}
                  </p>
                </div>
                {writable &&
                  (l.course ? (
                    <form action={unlinkLmsCourse}>
                      <input type="hidden" name="slug" value={slug} />
                      <input type="hidden" name="linkId" value={l.id} />
                      <Button type="submit" variant="secondary">
                        Unlink
                      </Button>
                    </form>
                  ) : (
                    <a href={`/i/${slug}/lti/link-course/${l.id}`} className="text-accent hover:underline">
                      Link to a course
                    </a>
                  ))}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
