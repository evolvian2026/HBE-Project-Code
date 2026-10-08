import type { Metadata } from "next";
import { PerformanceSummary, PerformanceTable } from "@/components/performance";
import { Card } from "@/components/ui";
import { requireMembership } from "@/lib/institution";
import { loadPerformance } from "@/lib/performance";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "My grades" };

/** A student's record: every assignment in every course, with released grades and reports. */
export default async function MyGradesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const { session, institution } = await requireMembership(slug);
  const supabase = await createSupabaseServerClient();
  const { rows, failedCategories } = await loadPerformance(supabase, institution.id, session.userId);
  return (
    <div className="space-y-6">
      <PerformanceSummary rows={rows} failed={failedCategories} />
      <Card
        title="All assignments"
        description="Grades appear once your instructors release them; every report version stays available."
      >
        <PerformanceTable slug={slug} rows={rows} staff={false} />
      </Card>
    </div>
  );
}
