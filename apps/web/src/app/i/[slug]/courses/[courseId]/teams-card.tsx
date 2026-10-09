import { Alert, Button, Card, EmptyState } from "@/components/ui";
import type { createSupabaseServerClient } from "@/lib/supabase/server";
import { autoTeams, createTeam, deleteTeam, setTeam } from "./team-actions";

type Supabase = Awaited<ReturnType<typeof createSupabaseServerClient>>;

interface TeamRow {
  id: string;
  name: string;
  members: {
    user_id: string;
    profile: { full_name: string | null; email: string | null; github_login: string | null } | null;
  }[];
}

const selectClass = "rounded-md border border-border bg-surface px-2 py-1.5 text-sm";
const inputClass = "rounded-md border border-border bg-surface px-2 py-1.5 text-sm";
const who = (p: TeamRow["members"][number]["profile"]) => p?.full_name ?? p?.email ?? p?.github_login ?? "Unknown";

/**
 * The course's teams (for team assignments). Staff form and change them; a student sees their
 * own team. Moving someone moves their open team-assignment work to the new team's repository.
 */
export async function TeamsCard({
  supabase,
  slug,
  courseId,
  canManage,
  isStaff,
  userId,
  students,
  query,
}: {
  supabase: Supabase;
  slug: string;
  courseId: string;
  canManage: boolean;
  isStaff: boolean;
  userId: string;
  students: { userId: string; name: string }[];
  query: Record<string, string | undefined>;
}) {
  const { data } = await supabase
    .from("teams")
    .select("id, name, members:team_members(user_id, profile:profiles(full_name, email, github_login))")
    .eq("course_id", courseId)
    .order("name");
  const teams = (data ?? []) as unknown as TeamRow[];
  if (!isStaff) {
    const mine = teams.find((t) => t.members.some((m) => m.user_id === userId));
    if (!mine) return null;
    return (
      <Card title="Your team" description="You share a repository with your team on team assignments.">
        <p className="text-sm font-medium" data-testid="my-team">
          {mine.name}
        </p>
        <ul className="mt-1 text-sm text-muted">
          {mine.members.map((m) => (
            <li key={m.user_id}>
              {who(m.profile)}
              {m.profile?.github_login && ` · @${m.profile.github_login}`}
            </li>
          ))}
        </ul>
      </Card>
    );
  }

  const inTeam = new Set(teams.flatMap((t) => t.members.map((m) => m.user_id)));
  const unteamed = students.filter((s) => !inTeam.has(s.userId));
  const ids = (
    <>
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="courseId" value={courseId} />
    </>
  );
  return (
    <section id="teams">
      <Card
        title="Teams"
        description="Team assignments give each team one repository. Members keep their own grades and process scores."
      >
        <div className="space-y-4 text-sm">
          {query.team_error && <Alert tone="error">{query.team_error}</Alert>}
          {query.team_done && <Alert tone="success">{query.team_done}</Alert>}
          {teams.length === 0 ? (
            <EmptyState title="No teams yet" />
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2" data-testid="teams">
              {teams.map((t) => (
                <li key={t.id} className="rounded-md border border-border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-medium">{t.name}</p>
                    {canManage && t.members.length === 0 && (
                      <form action={deleteTeam}>
                        {ids}
                        <input type="hidden" name="teamId" value={t.id} />
                        <button type="submit" className="text-xs text-danger hover:underline">
                          Delete
                        </button>
                      </form>
                    )}
                  </div>
                  <ul className="mt-2 space-y-1">
                    {t.members.map((m) => (
                      <li key={m.user_id} className="flex items-center justify-between gap-2">
                        <span>{who(m.profile)}</span>
                        {canManage && (
                          <form action={setTeam}>
                            {ids}
                            <input type="hidden" name="userId" value={m.user_id} />
                            <input type="hidden" name="teamId" value="" />
                            <button
                              type="submit"
                              className="text-xs text-muted hover:text-danger"
                              aria-label={`Remove ${who(m.profile)} from ${t.name}`}
                            >
                              Remove
                            </button>
                          </form>
                        )}
                      </li>
                    ))}
                    {t.members.length === 0 && <li className="text-muted">No members yet.</li>}
                  </ul>
                  {canManage && unteamed.length > 0 && (
                    <form action={setTeam} className="mt-2 flex items-center gap-2">
                      {ids}
                      <input type="hidden" name="teamId" value={t.id} />
                      <select
                        name="userId"
                        defaultValue=""
                        className={selectClass}
                        aria-label={`Add a student to ${t.name}`}
                      >
                        <option value="" disabled>
                          Add a student…
                        </option>
                        {unteamed.map((s) => (
                          <option key={s.userId} value={s.userId}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                      <Button type="submit" variant="secondary" className="px-2 py-1 text-xs">
                        Add
                      </Button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}
          {unteamed.length > 0 && (
            <p className="text-muted" data-testid="unteamed">
              Not in a team: {unteamed.map((s) => s.name).join(", ")}
            </p>
          )}
          {canManage && (
            <div className="flex flex-wrap items-end gap-4 border-t border-border pt-4">
              <form action={createTeam} className="flex items-center gap-2">
                {ids}
                <input name="name" required placeholder="Team name" aria-label="Team name" className={inputClass} />
                <Button type="submit" variant="secondary">
                  Create team
                </Button>
              </form>
              {unteamed.length > 1 && (
                <form action={autoTeams} className="flex items-center gap-2">
                  {ids}
                  <label className="flex items-center gap-2">
                    Teams of
                    <input
                      name="size"
                      type="number"
                      min={2}
                      max={12}
                      defaultValue={3}
                      className={`${inputClass} w-16`}
                      aria-label="Team size"
                    />
                  </label>
                  <Button type="submit" variant="secondary">
                    Form teams for the {unteamed.length} without one
                  </Button>
                </form>
              )}
            </div>
          )}
        </div>
      </Card>
    </section>
  );
}
