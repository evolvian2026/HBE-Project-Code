import Link from "next/link";
import type { ReactNode } from "react";
import type { SessionContext } from "@/lib/session";
import { InstitutionSwitcher } from "./institution-switcher";

export function AppShell({
  session,
  current,
  children,
}: {
  session: SessionContext;
  current?: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-dvh">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-3">
          <Link href="/" className="mr-2 font-semibold tracking-tight">
            HBE Projects
          </Link>
          <InstitutionSwitcher
            current={current ?? null}
            options={session.memberships.map((m) => ({ slug: m.institution.slug, name: m.institution.name }))}
          />
          {session.isSuperAdmin && (
            <Link href="/platform" className="text-sm text-muted hover:text-text">
              Platform
            </Link>
          )}
          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="hidden text-muted sm:inline">{session.email ?? session.githubLogin}</span>
            <form action="/auth/signout" method="post">
              <button className="text-muted hover:text-text">Sign out</button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  );
}

export function PageTitle({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}
