import { webConfig } from "./config";
import { createSupabaseServerClient } from "./supabase/server";

export type ApiResult<T> =
  { ok: true; data: T } | { ok: false; status: number; error: string; message: string; problems?: string[] };

/** Calls the api role as the signed-in user (server-side only). */
export async function apiFetch<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<ApiResult<T>> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session)
    return { ok: false, status: 401, error: "unauthorized", message: "Your session has expired. Sign in again." };

  const { API_URL, INTERNAL_API_URL } = webConfig();
  const res = await fetch(new URL(path, INTERNAL_API_URL ?? API_URL), {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${session.access_token}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    cache: "no-store",
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string; problems?: string[] };
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: body.error ?? "error",
      message: body.message ?? res.statusText,
      problems: body.problems,
    };
  }
  return { ok: true, data: body as T };
}
