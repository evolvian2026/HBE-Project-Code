"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { friendlyError, type ActionState } from "@/lib/actions";
import { requireSession } from "@/lib/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { EMAIL_TYPES } from "./types";

/** Which notification types the user also gets by email. */
export async function saveEmailPreferences(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession();
  const types = z
    .array(z.enum(EMAIL_TYPES.map((t) => t.type) as [string, ...string[]]))
    .safeParse(formData.getAll("types"));
  if (!types.success) return { ok: false, message: "Unknown notification type." };
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("profiles")
    .update({ email_notification_types: types.data })
    .eq("id", session.userId);
  if (error) return { ok: false, message: friendlyError(error) };
  revalidatePath("/account/notifications");
  return { ok: true, message: types.data.length ? "Saved." : "Saved. You won't get notification emails." };
}
