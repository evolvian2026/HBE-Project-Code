import { institutionSettings } from "@hbe/core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Alert, Badge, Button, Card, EmptyState } from "@/components/ui";
import { requireMembership } from "@/lib/institution";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { saveOffered, setStatus } from "./actions";
import { AddStackProfileForm } from "./forms";

export const metadata: Metadata = { title: "Stacks and test suites" };

interface Profile {
  id: string;
  institution_id: string | null;
  key: string;
  version: number;
  display_name: string;
  description: string | null;
  status: "active" | "retired";
}
interface Suite {
  id: string;
  institution_id: string | null;
  key: string;
  version: number;
  title: string;
  status: "active" | "retired";
  git_ref: string;
  profile: { display_name: string; version: number } | null;
}

function StatusButton({
  slug,
  kind,
  id,
  status,
}: {
  slug: string;
  kind: "profile" | "suite";
  id: string;
  status: string;
}) {
  return (
    <form action={setStatus}>
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="status" value={status === "active" ? "retired" : "active"} />
      <Button type="submit" variant="secondary" className="px-2 py-0.5 text-xs">
        {status === "active" ? "Retire" : "Restore"}
      </Button>
    </form>
  );
}

export default async function StacksPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const ctx = await requireMembership(slug);
  if (!ctx.isAdmin) notFound();
  const supabase = await createSupabaseServerClient();
  const [{ data: profileRows }, { data: suiteRows }, { data: assignments }, { data: inst }] = await Promise.all([
    supabase
      .from("stack_profiles")
      .select("id, institution_id, key, version, display_name, description, status")
      .order("key")
      .order("version", { ascending: false }),
    supabase
      .from("grader_suites")
      .select("id, institution_id, key, version, title, status, git_ref, profile:stack_profiles(display_name, version)")
      .order("key")
      .order("version", { ascending: false }),
    supabase.from("assignments").select("stack_profile_id, grader_suite_id").eq("institution_id", ctx.institution.id),
    supabase.from("institutions").select("settings").eq("id", ctx.institution.id).single(),
  ]);
  const profiles = (profileRows ?? []) as Profile[];
  const suites = (suiteRows ?? []) as unknown as Suite[];
  const uses = (key: "stack_profile_id" | "grader_suite_id", id: string) =>
    ((assignments ?? []) as Record<string, string | null>[]).filter((a) => a[key] === id).length;
  const hidden = new Set(institutionSettings(inst?.settings).hidden_stack_profiles);
  const globals = profiles.filter((p) => !p.institution_id);
  const own = profiles.filter((p) => p.institution_id);
  const used = (n: number) => (n ? `${n} assignment${n === 1 ? "" : "s"}` : "unused");

  return (
    <div className="space-y-6">
      {query.error && <Alert tone="error">{query.error}</Alert>}
      {query.saved && <Alert tone="success">Saved.</Alert>}

      <Card
        title="Global stack profiles"
        description="Maintained by the platform. Untick those your teachers shouldn't pick for new assignments."
      >
        <form action={saveOffered} className="space-y-3">
          <input type="hidden" name="slug" value={slug} />
          <ul className="divide-y divide-border text-sm" data-testid="global-profiles">
            {globals.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <label className="flex items-center gap-2">
                  <input type="hidden" name="global" value={p.id} />
                  <input
                    type="checkbox"
                    name="offered"
                    value={p.id}
                    defaultChecked={!hidden.has(p.id)}
                    disabled={p.status !== "active"}
                    aria-label={`Offer ${p.display_name} v${p.version}`}
                  />
                  <span>
                    {p.display_name}{" "}
                    <span className="text-muted">
                      · {p.key} v{p.version}
                    </span>
                  </span>
                </label>
                <span className="flex items-center gap-2 text-xs text-muted">
                  {used(uses("stack_profile_id", p.id))}
                  {p.status === "retired" && <Badge tone="neutral">retired</Badge>}
                </span>
              </li>
            ))}
          </ul>
          <Button type="submit" variant="secondary">
            Save choice
          </Button>
        </form>
      </Card>

      <Card
        title="Your stack profiles"
        description="Profiles only your institution uses. Retired ones stay for the assignments that used them."
      >
        {own.length === 0 ? (
          <EmptyState title="None yet" />
        ) : (
          <ul className="divide-y divide-border text-sm" data-testid="own-profiles">
            {own.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  {p.display_name}{" "}
                  <span className="text-muted">
                    · {p.key} v{p.version}
                  </span>
                  {p.description && <span className="block text-xs text-muted">{p.description}</span>}
                </span>
                <span className="flex items-center gap-2 text-xs text-muted">
                  {used(uses("stack_profile_id", p.id))}
                  <Badge tone={p.status === "active" ? "success" : "neutral"}>{p.status}</Badge>
                  <StatusButton slug={slug} kind="profile" id={p.id} status={p.status} />
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-6 border-t border-border pt-4">
          <h3 className="mb-3 text-sm font-medium">Add a stack profile</h3>
          <AddStackProfileForm slug={slug} />
        </div>
      </Card>

      <Card
        title="Test suites"
        description="Hidden tests, registered by the platform operator. A suite's versions can be retired, so they can't be chosen for new assignments."
      >
        {suites.length === 0 ? (
          <EmptyState title="No test suites" />
        ) : (
          <ul className="divide-y divide-border text-sm" data-testid="suites">
            {suites.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  {s.title}{" "}
                  <span className="text-muted">
                    · {s.key} v{s.version}
                  </span>
                  <span className="block text-xs text-muted">
                    {s.institution_id ? "your institution's" : "global"}
                    {s.profile && ` · for ${s.profile.display_name} v${s.profile.version}`} · ref {s.git_ref}
                  </span>
                </span>
                <span className="flex items-center gap-2 text-xs text-muted">
                  {used(uses("grader_suite_id", s.id))}
                  <Badge tone={s.status === "active" ? "success" : "neutral"}>{s.status}</Badge>
                  {s.institution_id && <StatusButton slug={slug} kind="suite" id={s.id} status={s.status} />}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
