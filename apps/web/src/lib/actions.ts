/** Result shape for forms driven by useActionState. */
export type ActionState = { ok: boolean; message: string; details?: string[] } | null;

interface PostgrestLikeError {
  code?: string;
  message: string;
}

/** Turns database errors into messages a person can act on. */
export function friendlyError(error: PostgrestLikeError): string {
  if (error.code === "P0001") return error.message;
  if (error.code === "42501") return "You don't have permission to do that.";
  if (error.code === "23505") return "That already exists.";
  if (error.code === "23503") return "That refers to something in another institution or that no longer exists.";
  return "Something went wrong. Try again.";
}
