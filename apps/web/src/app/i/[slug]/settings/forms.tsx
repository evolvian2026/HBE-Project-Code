"use client";

import type { AssignmentDefaults } from "@hbe/core";
import { useActionState } from "react";
import { FormStatus } from "@/components/form-status";
import { Button, Field } from "@/components/ui";
import { saveInstitutionSettings } from "./actions";

export function InstitutionSettingsForm({
  slug,
  name,
  defaults,
  disabled,
}: {
  slug: string;
  name: string;
  defaults: AssignmentDefaults;
  disabled: boolean;
}) {
  const [state, action, pending] = useActionState(saveInstitutionSettings, null);
  return (
    <form action={action} className="space-y-6">
      <input type="hidden" name="slug" value={slug} />
      <div className="max-w-md">
        <Field label="Institution name" name="name" required minLength={2} maxLength={200} defaultValue={name} />
      </div>
      <fieldset className="space-y-4 border-t border-border pt-4">
        <legend className="text-sm font-medium">New assignments start with</legend>
        <div className="grid gap-4 sm:grid-cols-4">
          <Field
            label="Test runs per student per day"
            name="runQuota"
            type="number"
            min={0}
            max={100}
            required
            defaultValue={defaults.run_quota_per_day}
          />
          <Field
            label="Automated tests (%)"
            name="automated"
            type="number"
            min={0}
            max={100}
            required
            defaultValue={defaults.weights.automated}
          />
          <Field
            label="Rubric (%)"
            name="rubric"
            type="number"
            min={0}
            max={100}
            required
            defaultValue={defaults.weights.rubric}
          />
          <Field
            label="Process (%)"
            name="process"
            type="number"
            min={0}
            max={100}
            required
            defaultValue={defaults.weights.process}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-4">
          <Field
            label="Late penalty per day (%)"
            name="latePerDay"
            type="number"
            min={0}
            max={100}
            required
            defaultValue={defaults.late_policy.per_day_percent}
          />
          <Field
            label="Late work accepted for (days)"
            name="lateMaxDays"
            type="number"
            min={0}
            max={60}
            required
            defaultValue={defaults.late_policy.max_days}
          />
          <Field
            label="Grace period (minutes)"
            name="lateGraceMinutes"
            type="number"
            min={0}
            max={1440}
            required
            defaultValue={defaults.late_policy.grace_minutes}
          />
          <Field
            label="Regrade requests for (days)"
            name="regradeWindowDays"
            type="number"
            min={0}
            max={60}
            required
            defaultValue={defaults.regrade_window_days}
          />
        </div>
        <div className="space-y-2 text-sm">
          <span className="font-medium">Run the tests</span>
          {(
            [
              ["onPush", defaults.triggers.on_push, "When students push to the default branch"],
              ["onPullRequest", defaults.triggers.on_pull_request, "On pull requests"],
              ["manualRuns", defaults.triggers.manual, "When students ask (within the daily limit)"],
            ] as const
          ).map(([field, checked, label]) => (
            <label key={field} className="flex items-center gap-2">
              <input type="checkbox" name={field} defaultChecked={checked} />
              {label}
            </label>
          ))}
          <label className="flex items-center gap-2">
            <input type="checkbox" name="postFeedbackToGithub" defaultChecked={defaults.post_feedback_to_github} />
            Post released feedback and code comments to GitHub (never the scores)
          </label>
        </div>
      </fieldset>
      <FormStatus state={state} />
      <Button type="submit" disabled={pending || disabled}>
        {pending ? "Saving…" : "Save settings"}
      </Button>
    </form>
  );
}
