import { NextResponse } from "next/server";
import { webConfig } from "@/lib/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function POST() {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL("/login", webConfig().APP_URL), { status: 303 });
}
