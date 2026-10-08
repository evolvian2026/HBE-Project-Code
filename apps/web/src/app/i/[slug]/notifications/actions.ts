"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireMembership } from "@/lib/institution";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function markAllNotificationsRead(formData: FormData) {
  const { slug } = z.object({ slug: z.string() }).parse(Object.fromEntries(formData));
  const { institution } = await requireMembership(slug);
  const supabase = await createSupabaseServerClient();
  await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("institution_id", institution.id)
    .is("read_at", null);
  revalidatePath(`/i/${slug}`, "layout");
}
