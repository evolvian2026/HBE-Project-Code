import { AppShell, PageTitle } from "@/components/app-shell";
import { ButtonLink, Card } from "@/components/ui";
import { requireSession } from "@/lib/session";

export default async function GithubInstalledPage() {
  const session = await requireSession();
  return (
    <AppShell session={session}>
      <PageTitle title="GitHub App installed" />
      <Card>
        <p className="text-sm">
          GitHub has notified the platform. The organisation is linked to your institution as soon as that notification
          is processed, usually within a few seconds.
        </p>
        <div className="mt-4">
          <ButtonLink href="/" variant="secondary">
            Back to dashboard
          </ButtonLink>
        </div>
      </Card>
    </AppShell>
  );
}
