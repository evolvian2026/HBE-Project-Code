import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell, PageTitle } from "@/components/app-shell";
import { Alert, Badge, Button, Card, EmptyState, Field } from "@/components/ui";
import { apiFetch } from "@/lib/api";
import { requireSession } from "@/lib/session";
import { createInstitution, mapInstallation } from "./actions";

export const metadata: Metadata = { title: "Platform console" };

interface InstitutionRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  member_count: number;
  admin_count: number;
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

  const [institutions, installations] = await Promise.all([
    apiFetch<{ institutions: InstitutionRow[] }>("/v1/platform/institutions"),
    apiFetch<{ installations: InstallationRow[] }>("/v1/platform/github-installations"),
  ]);
  const institutionList = institutions.ok ? institutions.data.institutions : [];
  const unlinked = installations.ok
    ? installations.data.installations.filter((i) => !i.institution_id && !i.deleted_at)
    : [];

  return (
    <AppShell session={session}>
      <PageTitle title="Platform console" subtitle="Institutions and GitHub installations across the platform." />
      <div className="space-y-6">
        {query.error && <Alert tone="error">{query.error}</Alert>}
        {query.created && <Alert tone="success">Institution “{query.created}” created.</Alert>}
        {query.mapped && <Alert tone="success">Installation assigned.</Alert>}
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
                          {i.name} {i.status !== "active" && <Badge tone="warning">{i.status}</Badge>}
                        </td>
                        <td className="py-2.5 text-muted">{i.slug}</td>
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
