import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell, PageTitle } from "@/components/app-shell";
import { Alert, Badge, Button, Card, EmptyState } from "@/components/ui";
import { apiFetch } from "@/lib/api";
import { enforceAdminMfa } from "@/lib/mfa";
import { requireSession } from "@/lib/session";
import { markDomainLive } from "./actions";

export const metadata: Metadata = { title: "Institution domains" };

interface Domains {
  provisioner: "render" | "manual";
  target: string;
  domains: { id: string; hostname: string; status: string; error: string | null; name: string; slug: string }[];
}

const TONE = { pending: "warning", provisioning: "accent", active: "success", failed: "danger" } as const;

/** Institutions' own domains; with manual provisioning, the operator turns each one on. */
export default async function DomainsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await requireSession();
  if (!session.isSuperAdmin) notFound();
  await enforceAdminMfa("/platform/domains");
  const query = await searchParams;
  const result = await apiFetch<Domains>("/v1/platform/domains");
  const data = result.ok ? result.data : null;
  return (
    <AppShell session={session}>
      <PageTitle
        title="Institution domains"
        subtitle={
          data?.provisioner === "manual"
            ? `Add each domain whose ownership is confirmed to the hosting (CNAME to ${data.target}, with a certificate), then mark it live.`
            : "Domains are added to the hosting automatically once their owners confirm them."
        }
      />
      {query.error && <Alert tone="error">{query.error}</Alert>}
      {query.done && <Alert tone="success">The domain is live.</Alert>}
      <Card>
        {!data || data.domains.length === 0 ? (
          <EmptyState title="No institution has added a domain" />
        ) : (
          <ul className="divide-y divide-border text-sm">
            {data.domains.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <span>
                  <span className="font-medium">{d.hostname}</span>{" "}
                  <span className="text-muted">
                    · {d.name} ({d.slug})
                  </span>
                  {d.error && d.status !== "active" && <span className="block text-xs text-muted">{d.error}</span>}
                </span>
                <span className="flex items-center gap-3">
                  <Badge tone={TONE[d.status as keyof typeof TONE] ?? "neutral"}>{d.status}</Badge>
                  {data.provisioner === "manual" && d.status === "provisioning" && (
                    <form action={markDomainLive}>
                      <input type="hidden" name="domainId" value={d.id} />
                      <Button type="submit" aria-label={`Mark ${d.hostname} live`}>
                        Mark live
                      </Button>
                    </form>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </AppShell>
  );
}
