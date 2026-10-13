"use client";

import { createClient } from "@supabase/supabase-js";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/** What the browser needs to subscribe to Realtime as the signed-in person (see lib/realtime). */
export interface RealtimeAuth {
  url: string;
  key: string;
  token: string;
}

/** Seconds since the epoch at which a JWT expires, if it says. */
function expiresAt(token: string): number | null {
  try {
    const payload = JSON.parse(atob(token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"))) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

/**
 * Re-renders the page as soon as a test run it shows changes: Supabase Realtime sends the
 * changes of `evaluation_runs` rows matching `filter` (e.g. `submission_id=in.(…)`) that the
 * person may read (RLS). Without a Realtime connection, it polls while something is `active`.
 */
export function LiveRuns({
  realtime,
  filter,
  active,
  intervalMs = 4000,
}: {
  realtime: RealtimeAuth | null;
  filter: string;
  active: boolean;
  intervalMs?: number;
}) {
  const router = useRouter();
  const [live, setLive] = useState(false);
  const { url, key, token } = realtime ?? {};

  useEffect(() => {
    if (!url || !key || !token) return;
    const client = createClient(url, key, {
      accessToken: async () => token,
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    let pending: ReturnType<typeof setTimeout> | undefined;
    // Several changes in a burst (a run's status, then its score) make one refresh.
    const refresh = () => {
      clearTimeout(pending);
      pending = setTimeout(() => router.refresh(), 250);
    };
    const channel = client
      .channel(`runs:${filter}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "evaluation_runs", filter }, refresh)
      // Joining the channel isn't enough: changes are sent once Realtime has subscribed to the
      // database, which it confirms separately. Then refresh once, for any change made since
      // the page was rendered.
      .on("system", {}, (payload: { extension?: string; status?: string }) => {
        if (payload.extension === "postgres_changes" && payload.status === "ok") {
          setLive(true);
          refresh();
        }
      });
    // Join as the person (not with the public key), so RLS decides what they're sent.
    let closed = false;
    void client.realtime.setAuth(token).then(() => {
      if (!closed) channel.subscribe((status) => status !== "SUBSCRIBED" && setLive(false));
    });
    // Before the token expires, re-render: the server hands out a fresh one.
    const exp = expiresAt(token);
    const renew = exp
      ? setTimeout(() => router.refresh(), Math.max(10_000, exp * 1000 - Date.now() - 60_000))
      : undefined;
    return () => {
      closed = true;
      clearTimeout(pending);
      clearTimeout(renew);
      setLive(false);
      void client.removeChannel(channel);
    };
  }, [url, key, token, filter, router]);

  useEffect(() => {
    if (live || !active) return;
    const id = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(id);
  }, [live, active, intervalMs, router]);

  return <span hidden data-testid="live-runs" data-live={live ? "on" : "off"} />;
}
