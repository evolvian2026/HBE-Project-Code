import { timeAgo } from "@hbe/core";
import type { Metadata } from "next";
import { Button, Card, EmptyState } from "@/components/ui";
import { requireMembership } from "@/lib/institution";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { markAllNotificationsRead } from "./actions";

export const metadata: Metadata = { title: "Notifications" };

export default async function NotificationsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { institution } = await requireMembership(slug);
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("notifications")
    .select("id, title, body, link, created_at, read_at")
    .eq("institution_id", institution.id)
    .order("created_at", { ascending: false })
    .limit(100);
  const items = data ?? [];
  const unread = items.filter((n) => !n.read_at).length;

  return (
    <Card
      title="Notifications"
      description={unread ? `${unread} unread` : "All caught up"}
      actions={
        unread > 0 && (
          <form action={markAllNotificationsRead}>
            <input type="hidden" name="slug" value={slug} />
            <Button type="submit" variant="secondary">
              Mark all as read
            </Button>
          </form>
        )
      }
    >
      {items.length === 0 ? (
        <EmptyState title="No notifications yet">
          Test results, released grades, extensions and deadline reminders show up here.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-border" data-testid="notifications">
          {items.map((n) => (
            <li key={n.id} className="py-2.5 text-sm">
              {/* A full navigation: the mark-read route redirects, and the header count must refresh. */}
              <a href={`/i/${slug}/notifications/${n.id}`} className="block hover:text-accent">
                <span className={n.read_at ? "" : "font-medium"}>
                  {!n.read_at && (
                    <span className="mr-1.5 inline-block size-2 rounded-full bg-accent" aria-label="unread" />
                  )}
                  {n.title}
                </span>
                {n.body && <span className="block text-muted">{n.body}</span>}
                <span className="block text-xs text-muted">{timeAgo(n.created_at)}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
