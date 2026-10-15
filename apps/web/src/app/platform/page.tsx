import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell, PageTitle } from "@/components/app-shell";
import { Alert, Badge, Button, Card, EmptyState, Field } from "@/components/ui";
import { apiFetch } from "@/lib/api";
import { enforceAdminMfa } from "@/lib/mfa";
import { requireSession } from "@/lib/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  createInstitution,
  disableInstitutionSso,
  mapInstallation,
  registerSuite,
  reopenContract,
  reviewSso,
  saveBanner,
  saveLimits,
} from "./actions";

export const metadata: Metadata = { title: "Platform console" };

interface InstitutionRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  contract_ended_at: string | null;
  purge_after: string | null;
  member_count: number;
  admin_count: number;
  student_count: number;
  limits: { max_active_students?: number; institution_concurrency?: number; monthly_runner_minutes?: number };
}
interface InstallationRow {
  installation_id: number;
  account_login: string;
  account_type: string;
  institution_id: string | null;
  institution_slug: string | null;
  deleted_at: string | null;
}

export default async function PlatformPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const [session, query] = await Promise.all([requireSession(), searchParams]);
  if (!session.isSuperAdmin) notFound();
  await enforceAdminMfa("/platform");

  const supabase = await createSupabaseServerClient();
  const [institutions, installations, { data: banner }, { data: globalProfiles }, { data: ssoRows }] =
    await Promise.all([
      apiFetch<{
        institutions: InstitutionRow[];
        plan: { institutionConcurrency: number; monthlyRunnerMinutes: number };
      }>("/v1/platform/institutions"),
      apiFetch<{ installations: InstallationRow[] }>("/v1/platform/github-installations"),
      supabase.from("platform_settings").select("value").eq("key", "maintenance_banner").maybeSingle(),
      supabase
        .from("stack_profiles")
        .select("id, display_name, version")
        .is("institution_id", null)
        .eq("status", "active")
        .order("display_name"),
      supabase
        .from("sso_connections")
        .select("id, institution_id, status, domains, metadata_url, join_as_student, created_at")
        .in("status", ["pending", "active"])
        .order("created_at"),
    ]);
  const sso = (ssoRows ?? []) as {
    id: string;
    institution_id: string;
    status: "pending" | "active";
    domains: string[];
    metadata_url: string | null;
    join_as_student: boolean;
  }[];
  const institutionName = (id: string) =>
    (institutions.ok ? institutions.data.institutions : []).find((i) => i.id === id)?.name ?? id;
  const plan = institutions.ok ? institutions.data.plan : null;
  const institutionList = institutions.ok ? institutions.data.institutions : [];
  const unlinked = installations.ok
    ? installations.data.installations.filter((i) => !i.institution_id && !i.deleted_at)
    : [];

  return (
    <AppShell session={session}>
      <PageTitle
        title="Platform console"
        subtitle={
          <>
            Institutions and GitHub installations across the platform.{" "}
            <Link href="/platform/health" className="link">
              System health
            </Link>
            {" · "}
            <Link href="/platform/audit" className="link">
              Audit log
            </Link>
            {" · "}
            <Link href="/platform/domains" className="link">
              Institution domains
            </Link>
          </>
        }
      />
      <div className="space-y-6">
        {query.error && <Alert tone="error">{query.error}</Alert>}
        {query.created && <Alert tone="success">Institution “{query.created}” created.</Alert>}
        {query.mapped && <Alert tone="success">Installation assigned.</Alert>}
        {query.limits && <Alert tone="success">Limits saved.</Alert>}
        {query.suite && <Alert tone="success">Test suite {query.suite} registered.</Alert>}
        {query.sso && (
          <Alert tone="success">
            Single sign-on {query.sso === "declined" ? "request declined" : `turned ${query.sso}`}.
          </Alert>
        )}
        {query.banner && <Alert tone="success">Notice {query.banner === "on" ? "shown" : "removed"}.</Alert>}
        {!institutions.ok && <Alert tone="error">Could not load institutions: {institutions.message}</Alert>}

        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <Card title="Institutions" description={`${institutionList.length} total`}>
              {institutionList.length === 0 ? (
                <EmptyState title="No institutions yet" />
              ) : (
                <table className="w-full text-sm">
                  <thead className="text-left text-muted">
                    <tr>
                      <th className="pb-2 font-medium">Name</th>
                      <th className="pb-2 font-medium">Slug</th>
                      <th className="pb-2 text-right font-medium">Members</th>
                      <th className="pb-2 text-right font-medium">Admins</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {institutionList.map((i) => (
                      <tr key={i.id}>
                        <td className="py-2.5 font-medium">
                          {i.name} {i.status !== "active" && <Badge tone="warning">{i.status.replace("_", " ")}</Badge>}
                          {i.purge_after && i.status === "read_only" && (
                            <span className="mt-1 flex flex-wrap items-center gap-2 text-xs font-normal text-muted">
                              records deleted {new Date(i.purge_after).toISOString().slice(0, 10)}
                              <form action={reopenContract}>
                                <input type="hidden" name="institutionId" value={i.id} />
                                <button type="submit" className="link">
                                  Reopen contract
                                </button>
                              </form>
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 text-muted">
                          {i.slug}
                          <details className="mt-1 text-xs">
                            <summary className="cursor-pointer text-accent">
                              Limits
                              {i.limits.max_active_students
                                ? ` · ${i.student_count}/${i.limits.max_active_students} students`
                                : ""}
                            </summary>
                            <form action={saveLimits} className="mt-2 space-y-2" aria-label={`Limits for ${i.name}`}>
                              <input type="hidden" name="institutionId" value={i.id} />
                              <Field
                                label="Active students"
                                name="maxActiveStudents"
                                type="number"
                                min={1}
                                defaultValue={i.limits.max_active_students ?? ""}
                                hint="Blank: no limit"
                              />
                              <Field
                                label="Test runs at once"
                                name="institutionConcurrency"
                                type="number"
                                min={1}
                                max={plan?.institutionConcurrency}
                                defaultValue={i.limits.institution_concurrency ?? ""}
                                hint={`Blank: the plan's ${plan?.institutionConcurrency ?? ""}`}
                              />
                              <Field
                                label="Runner minutes per month"
                                name="monthlyRunnerMinutes"
                                type="number"
                                min={1}
                                max={plan?.monthlyRunnerMinutes}
                                defaultValue={i.limits.monthly_runner_minutes ?? ""}
                                hint={`Blank: the plan's ${plan?.monthlyRunnerMinutes ?? ""}`}
                              />
                              <Button type="submit" variant="secondary">
                                Save limits
                              </Button>
                            </form>
                          </details>
                        </td>
                        <td className="py-2.5 text-right tabular-nums">{i.member_count}</td>
                        <td className="py-2.5 text-right tabular-nums">
                          {i.admin_count === 0 ? <Badge tone="warning">invite pending</Badge> : i.admin_count}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </div>

          <Card title="New institution" description="The admin is invited by email and joins on first sign-in.">
            <form action={createInstitution} className="space-y-3">
              <Field label="Name" name="name" required minLength={2} maxLength={200} placeholder="Alpha University" />
              <Field
                label="Slug"
                name="slug"
                pattern="[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?"
                hint="Optional. Derived from the name."
              />
              <Field label="First admin's email" name="adminEmail" type="email" placeholder="head@alpha.edu" />
              <Button type="submit" className="w-full">
                Create institution
              </Button>
            </form>
          </Card>
        </div>

        <Card
          title="Single sign-on"
          description="Turn it on only once you've checked the institution owns the domains: its identity provider can sign anyone in with an address there."
        >
          {sso.length === 0 ? (
            <EmptyState title="No requests" />
          ) : (
            <ul className="divide-y divide-border text-sm" data-testid="sso-requests">
              {sso.map((c) => (
                <li key={c.id} className="flex flex-wrap items-start justify-between gap-3 py-2.5">
                  <span>
                    <span className="font-medium">{institutionName(c.institution_id)}</span>{" "}
                    <Badge tone={c.status === "active" ? "success" : "warning"}>
                      {c.status === "active" ? "on" : "asked"}
                    </Badge>
                    <span className="block text-xs text-muted">
                      {c.domains.join(", ")} · {c.metadata_url ?? "metadata file"}
                      {c.join_as_student && " · open to students"}
                    </span>
                  </span>
                  {c.status === "pending" ? (
                    <form
                      action={reviewSso}
                      className="flex flex-wrap items-center gap-2"
                      aria-label={`Review single sign-on for ${institutionName(c.institution_id)}`}
                    >
                      <input type="hidden" name="connectionId" value={c.id} />
                      <input
                        name="note"
                        aria-label="Note"
                        placeholder="Note (optional)"
                        className="rounded-md border border-border bg-surface px-2 py-1.5"
                      />
                      <Button type="submit" name="decision" value="approve" variant="secondary">
                        Turn on
                      </Button>
                      <Button type="submit" name="decision" value="reject" variant="secondary">
                        Decline
                      </Button>
                    </form>
                  ) : (
                    <form action={disableInstitutionSso}>
                      <input type="hidden" name="institutionId" value={c.institution_id} />
                      <Button type="submit" variant="secondary">
                        Turn off
                      </Button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title="Register a test suite version"
          description="Its code must already be in the grader repository. Registering the same key again adds its next version."
        >
          <form action={registerSuite} className="grid gap-3 sm:grid-cols-3">
            <label className="text-sm">
              <span className="font-medium">For</span>
              <select
                name="institutionId"
                className="mt-1 block w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
              >
                <option value="">Every institution (global)</option>
                {institutionList.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
            </label>
            <Field
              label="Suite key"
              name="key"
              required
              pattern="[a-z0-9][a-z0-9-]{1,48}[a-z0-9]"
              placeholder="shop-api"
            />
            <Field label="Title" name="title" required minLength={2} maxLength={200} placeholder="Shop API" />
            <Field label="Folder in the grader repository" name="path" required placeholder="suites/acme/shop-api" />
            <Field label="Git ref" name="gitRef" defaultValue="main" />
            <label className="text-sm">
              <span className="font-medium">Stack profile (optional)</span>
              <select
                name="stackProfileId"
                className="mt-1 block w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
              >
                <option value="">Any</option>
                {(globalProfiles ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.display_name} v{p.version}
                  </option>
                ))}
              </select>
            </label>
            <div className="sm:col-span-3">
              <Button type="submit" variant="secondary">
                Register suite
              </Button>
            </div>
          </form>
        </Card>

        <Card title="Notice for everyone" description="Shown at the top of every page, e.g. planned maintenance.">
          <form action={saveBanner} className="flex flex-wrap items-end gap-3">
            <div className="min-w-72 flex-1">
              <Field
                label="Notice"
                name="message"
                maxLength={300}
                defaultValue={typeof banner?.value === "string" ? banner.value : ""}
                placeholder="Maintenance on Saturday 10:00–11:00 SGT: test runs may be delayed."
                hint="Leave empty to show nothing."
              />
            </div>
            <Button type="submit" variant="secondary">
              Save notice
            </Button>
          </form>
        </Card>

        <Card title="Unassigned GitHub installations" description="Installations that were not linked automatically.">
          {unlinked.length === 0 ? (
            <EmptyState title="Nothing to assign" />
          ) : (
            <ul className="divide-y divide-border">
              {unlinked.map((i) => (
                <li
                  key={i.installation_id}
                  className="flex flex-wrap items-center justify-between gap-3 py-2.5 text-sm"
                >
                  <span>
                    <span className="font-medium">{i.account_login}</span>{" "}
                    <span className="text-muted">({i.account_type})</span>
                  </span>
                  <form action={mapInstallation} className="flex items-center gap-2">
                    <input type="hidden" name="installationId" value={i.installation_id} />
                    <select
                      name="institutionId"
                      required
                      aria-label={`Institution for ${i.account_login}`}
                      className="rounded-md border border-border bg-surface px-2 py-1.5"
                    >
                      {institutionList.map((inst) => (
                        <option key={inst.id} value={inst.id}>
                          {inst.name}
                        </option>
                      ))}
                    </select>
                    <Button type="submit" variant="secondary">
                      Assign
                    </Button>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </AppShell>
  );
}
