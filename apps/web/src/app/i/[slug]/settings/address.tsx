import { Alert, Badge, Button, Card, Field } from "@/components/ui";
import { addDomain, checkDomain, removeDomain } from "./domain-actions";

export interface InstitutionAddress {
  platformUrl: string;
  subdomainUrl: string | null;
  target: string;
  provisioner: "render" | "manual";
  domain: {
    hostname: string;
    url: string;
    status: "pending" | "provisioning" | "active" | "failed";
    error: string | null;
    record: { name: string; value: string };
  } | null;
}

const STATUS = {
  pending: { label: "waiting for the DNS record", tone: "warning" },
  provisioning: { label: "ownership confirmed, going live", tone: "accent" },
  active: { label: "live", tone: "success" },
  failed: { label: "couldn't go live", tone: "danger" },
} as const;

/** Institution admins: where people reach the institution, and its own domain. */
export function AddressCard({
  slug,
  address,
  query,
}: {
  slug: string;
  address: InstitutionAddress;
  query: Record<string, string | undefined>;
}) {
  const d = address.domain;
  return (
    <section id="address">
      <Card
        title="Web address"
        description="Where people reach your institution. Every address shows the same courses; people sign in once."
      >
        <div className="space-y-4 text-sm">
          {query.address_error && <Alert tone="error">{query.address_error}</Alert>}
          {query.address && <Alert tone="success">{query.address}</Alert>}
          <ul className="space-y-1">
            {d?.status === "active" && (
              <li>
                Your domain:{" "}
                <a className="link" href={d.url}>
                  {d.hostname}
                </a>
              </li>
            )}
            {address.subdomainUrl && (
              <li>
                Your subdomain:{" "}
                <a className="link" href={address.subdomainUrl}>
                  {address.subdomainUrl.replace(/^https?:\/\//, "")}
                </a>
              </li>
            )}
            <li>
              On the platform:{" "}
              <a className="link break-all" href={address.platformUrl}>
                {address.platformUrl.replace(/^https?:\/\//, "")}
              </a>
            </li>
          </ul>

          {d ? (
            <div className="space-y-3 border-t border-border pt-4">
              <p className="flex flex-wrap items-center gap-2" data-testid="domain-status">
                <span className="font-medium">{d.hostname}</span>
                <Badge tone={STATUS[d.status].tone}>{STATUS[d.status].label}</Badge>
              </p>
              {d.error && d.status !== "active" && <p className="text-muted">{d.error}</p>}
              {d.status !== "active" && (
                <div className="overflow-x-auto rounded-md border border-border p-3 text-xs">
                  <p className="mb-2 font-medium">Set these DNS records at your domain&apos;s DNS provider</p>
                  <table className="w-full text-left">
                    <caption className="sr-only">DNS records for {d.hostname}</caption>
                    <thead className="text-muted">
                      <tr>
                        <th scope="col" className="pr-3 font-medium">
                          Type
                        </th>
                        <th scope="col" className="pr-3 font-medium">
                          Name
                        </th>
                        <th scope="col" className="font-medium">
                          Value
                        </th>
                      </tr>
                    </thead>
                    <tbody className="font-mono">
                      <tr>
                        <td className="pr-3">TXT</td>
                        <td className="break-all pr-3">{d.record.name}</td>
                        <td className="break-all">{d.record.value}</td>
                      </tr>
                      <tr>
                        <td className="pr-3">CNAME</td>
                        <td className="break-all pr-3">{d.hostname}</td>
                        <td className="break-all">{address.target}</td>
                      </tr>
                    </tbody>
                  </table>
                  <p className="mt-2 text-muted">
                    The TXT record proves the domain is yours; the CNAME sends visitors here.{" "}
                    {address.provisioner === "manual"
                      ? "Once ownership is confirmed, the platform operator turns the domain on."
                      : "Once ownership is confirmed, the certificate is issued automatically."}
                  </p>
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                {d.status !== "active" && (
                  <form action={checkDomain}>
                    <input type="hidden" name="slug" value={slug} />
                    <Button type="submit">Check now</Button>
                  </form>
                )}
                <form action={removeDomain}>
                  <input type="hidden" name="slug" value={slug} />
                  <Button type="submit" variant="secondary">
                    Remove domain
                  </Button>
                </form>
              </div>
            </div>
          ) : (
            <form action={addDomain} className="space-y-3 border-t border-border pt-4">
              <input type="hidden" name="slug" value={slug} />
              <Field
                label="Your own domain (optional)"
                name="hostname"
                required
                placeholder="projects.example.edu"
                hint="A domain or subdomain your institution owns. You'll set two DNS records for it."
              />
              <Button type="submit">Add domain</Button>
            </form>
          )}
        </div>
      </Card>
    </section>
  );
}
