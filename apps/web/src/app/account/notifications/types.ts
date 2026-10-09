/** Notification types a user can also get by email, in the order they're offered. */
export const EMAIL_TYPES = [
  { type: "grade_released", label: "Grades released or updated" },
  { type: "regrade_answered", label: "Answers to your regrade requests" },
  { type: "deadline_soon", label: "Deadline reminders (24 hours before)" },
  { type: "extension_granted", label: "Deadline extensions" },
  { type: "run_finished", label: "Test results (after every graded or requested run)" },
  { type: "regrade_requested", label: "Regrade requests from students (course staff)" },
  { type: "commit_claim", label: "Commit claims (to confirm, or the decision on yours)" },
] as const;
