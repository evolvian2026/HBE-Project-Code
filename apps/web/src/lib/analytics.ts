/** What the api's analytics endpoints answer (apps/server/src/analytics.ts). */
export interface AssignmentAnalytics {
  summary: {
    submissions: number;
    started: number;
    tested: number;
    medianTestScore: number | null;
    graded: number;
    medianGrade: number | null;
    late: number;
    missing: number;
  };
  tests: { key: string; title: string; stage: string; total: number; failing: number }[];
  heatmap: { days: string[]; rows: { key: string; title: string; cells: { runs: number; failed: number }[] }[] };
  testScores: { from: number; to: number; count: number }[];
  grades: { from: number; to: number; count: number }[];
}

export interface StudentRisk {
  userId: string;
  name: string;
  level: "high" | "medium";
  reasons: string[];
}

export interface Cohorts {
  code: string;
  terms: { courseId: string; term: string; current: boolean; students: number }[];
  assignments: {
    slug: string;
    title: string;
    terms: {
      courseId: string;
      term: string;
      submissions: number;
      suppressed: boolean;
      medianGrade: number | null;
      meanGrade: number | null;
      medianTestScore: number | null;
      onTimeRate: number | null;
      missingRate: number | null;
      mostFailed: { title: string; rate: number }[];
    }[];
  }[];
}

/** "14 Oct" for a YYYY-MM-DD day. */
export const shortDay = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString("en-SG", { day: "numeric", month: "short", timeZone: "UTC" });
