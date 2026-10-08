import type { ActionState } from "@/lib/actions";
import { Alert } from "./ui";

export function FormStatus({ state }: { state: ActionState }) {
  if (!state) return null;
  return (
    <Alert tone={state.ok ? "success" : "error"}>
      <p>{state.message}</p>
      {state.details && state.details.length > 0 && (
        <ul className="mt-2 list-disc space-y-0.5 pl-5">
          {state.details.slice(0, 20).map((d) => (
            <li key={d}>{d}</li>
          ))}
          {state.details.length > 20 && <li>…and {state.details.length - 20} more</li>}
        </ul>
      )}
    </Alert>
  );
}
